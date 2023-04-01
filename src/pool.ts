/* eslint-disable prefer-const */
import { CrocContext } from "./context";
import { sortBaseQuoteTokens, decodeCrocPrice, toDisplayPrice, bigNumToFloat, toDisplayQty, fromDisplayPrice, roundForConcLiq, concDepositSkew, pinTickLower, pinTickUpper } from './utils';
import { CrocTokenView, TokenQty } from './tokens';
import { TransactionResponse } from '@ethersproject/providers';
import { WarmPathEncoder } from './encoding/liquidity';
import { BigNumber, BigNumberish, ethers } from 'ethers';
import { AddressZero } from '@ethersproject/constants';
import { PoolInitEncoder } from "./encoding/init";
import { CrocSurplusFlags, decodeSurplusFlag, encodeSurplusArg } from "./encoding/flags";

type PriceRange = [number, number]
type TickRange = [number, number]

export class CrocPoolView {

    constructor (quoteToken: string, baseToken: string, context: Promise<CrocContext>) {
        [this.baseToken, this.quoteToken] = 
            sortBaseQuoteTokens(baseToken, quoteToken)
        this.context = context

        this.baseTokenView = new CrocTokenView(context, this.baseToken)
        this.quoteTokenView = new CrocTokenView(context, this.quoteToken)

        this.baseDecimals = this.baseTokenView.decimals
        this.quoteDecimals = this.quoteTokenView.decimals

        this.useTrueBase = this.baseToken === baseToken
    }

    async isInit(): Promise<boolean> {
        return this.spotPrice()
            .then(p => p > 0)
    }

    async spotPrice(): Promise<number> {
        let sqrtPrice = (await this.context).query.queryPrice
            (this.baseToken, this.quoteToken, (await this.context).chain.poolIndex)
        return decodeCrocPrice(await sqrtPrice)
    }

    async displayPrice(): Promise<number> {
        let spotPrice = this.spotPrice()
        return this.toDisplayPrice(await spotPrice)
    }

    async spotTick(): Promise<number> {
        return (await this.context).query.queryCurveTick
            (this.baseToken, this.quoteToken, (await this.context).chain.poolIndex)
    }

    async toDisplayPrice (spotPrice: number): Promise<number> {
        return toDisplayPrice(spotPrice, await this.baseDecimals, await this.quoteDecimals,
            !this.useTrueBase)
    }

    async fromDisplayPrice (dispPrice: number): Promise<number> {
        return fromDisplayPrice(dispPrice, await this.baseDecimals, await this.quoteDecimals, 
            !this.useTrueBase)
    }

    async displayToPinTick (dispPrice: number): Promise<[number, number]> {
        const spotPrice = await this.fromDisplayPrice(dispPrice)
        const gridSize = (await this.context).chain.gridSize
        return [pinTickLower(spotPrice, gridSize), pinTickUpper(spotPrice, gridSize)]
    }

    async initPool (initPrice: number): Promise<TransactionResponse> {
        // Very small amount of ETH in economic terms but more than sufficient for min init burn
        const ETH_INIT_BURN = BigNumber.from(10).pow(12)
        let txArgs = this.baseToken === AddressZero ? { value: ETH_INIT_BURN } : { }
        
        let encoder = new PoolInitEncoder(this.baseToken, this.quoteToken, 
            (await this.context).chain.poolIndex)
        let spotPrice = this.fromDisplayPrice(initPrice)
        let calldata = encoder.encodeInitialize(await spotPrice)        
        return this.sendCmd(calldata, txArgs)
    }

    async mintAmbientBase (qty: TokenQty, limits: PriceRange, opts?: CrocLpOpts): 
        Promise<TransactionResponse> {
        return this.mintAmbient(qty, this.useTrueBase, limits, opts)
    }

    async mintAmbientQuote (qty: TokenQty, limits: PriceRange, opts?: CrocLpOpts): 
        Promise<TransactionResponse> {
        return this.mintAmbient(qty, !this.useTrueBase, limits, opts)
    }

    async mintRangeBase (qty: TokenQty, range: TickRange, limits: PriceRange, opts?: CrocLpOpts): 
        Promise<TransactionResponse> {
        return this.mintRange(qty, this.useTrueBase, range, await limits, opts)
    }

    async mintRangeQuote (qty: TokenQty, range: TickRange, limits: PriceRange, opts?: CrocLpOpts): 
        Promise<TransactionResponse> {
        return this.mintRange(qty, !this.useTrueBase, range, await limits, opts)
    }

    async burnAmbientLiq (liq: BigNumber, limits: PriceRange, opts?: CrocLpOpts): 
        Promise<TransactionResponse> {
        let [lowerBound, upperBound] = await this.transformLimits(limits)
        const calldata = (await this.makeEncoder()).encodeBurnAmbient
            (liq, lowerBound, upperBound, this.maskSurplusFlag(opts))
        return this.sendCmd(calldata)
    }

    async burnAmbientAll (limits: PriceRange, opts?: CrocLpOpts): Promise<TransactionResponse> {
        let [lowerBound, upperBound] = await this.transformLimits(limits)
        const calldata = (await this.makeEncoder()).encodeBurnAmbientAll
            (lowerBound, upperBound, this.maskSurplusFlag(opts))
        return this.sendCmd(calldata)
    }

    async burnRangeLiq (liq: BigNumber, range: TickRange, limits: PriceRange, opts?: CrocLpOpts): 
        Promise<TransactionResponse> {
        let [lowerBound, upperBound] = await this.transformLimits(limits)
        let roundLotLiq = roundForConcLiq(liq)
        const calldata = (await this.makeEncoder()).encodeBurnConc
            (range[0], range[1], roundLotLiq, lowerBound, upperBound, this.maskSurplusFlag(opts))
        return this.sendCmd(calldata)
    }

    async harvestRange (range: TickRange, limits: PriceRange, opts?: CrocLpOpts): 
        Promise<TransactionResponse> {
        let [lowerBound, upperBound] = await this.transformLimits(limits)
        const calldata = (await this.makeEncoder()).encodeHarvestConc
            (range[0], range[1], lowerBound, upperBound, this.maskSurplusFlag(opts))
        return this.sendCmd(calldata)
    }

    private async sendCmd (calldata: string, txArgs?: { value?: BigNumberish}): 
        Promise<TransactionResponse> {
        let cntx = await this.context
        return cntx.dex.userCmd(cntx.chain.proxyPaths.liq, calldata, txArgs)
    }

    private async mintAmbient (qty: TokenQty, isQtyBase: boolean, 
        limits: PriceRange, opts?: CrocLpOpts): Promise<TransactionResponse> {
        let msgVal = this.msgValAmbient(qty, isQtyBase, limits, opts)
        let weiQty = this.normQty(qty, isQtyBase)
        let [lowerBound, upperBound] = await this.transformLimits(limits)

        const calldata = (await this.makeEncoder()).encodeMintAmbient(
            await weiQty, isQtyBase, lowerBound, upperBound, this.maskSurplusFlag(opts))
        return this.sendCmd(calldata, {value: await msgVal})
    }

    private async boundLimits (range: TickRange, limits: PriceRange): Promise<PriceRange> {
        let spotPrice = this.spotPrice()
        const [lowerPrice, upperPrice] = this.rangeToPrice(range)
        const [boundLower, boundUpper] = await this.transformLimits(limits)
        const BOUND_PREC = 1.0001

        let [amplifyLower, amplifyUpper] = [boundLower, boundUpper]

        if (upperPrice < await spotPrice) {
            amplifyLower = upperPrice*BOUND_PREC
        } else if (lowerPrice > await spotPrice) {
            amplifyUpper = lowerPrice/BOUND_PREC

        } else {
            // Generally assume we don't want to send more than 5X the floating side token implied
            // by current price
            const MAX_AMPLICATION = 10.0
            const slippageCap = 1 - Math.pow(1 - 1/MAX_AMPLICATION, 2)

            amplifyLower = ((await spotPrice) - lowerPrice) * slippageCap + lowerPrice
            amplifyUpper = upperPrice - (upperPrice - (await spotPrice)) * slippageCap
        }

        return this.untransformLimits(
                [Math.max(amplifyLower, boundLower), Math.min(amplifyUpper, boundUpper)])
    }

    private rangeToPrice (range: TickRange): PriceRange {
        const lowerPrice = Math.pow(1.0001, range[0])
        const upperPrice = Math.pow(1.0001, range[1])
        return [lowerPrice, upperPrice]
    }

    private async transformLimits (limits: PriceRange): Promise<PriceRange> {
        let left = this.fromDisplayPrice(limits[0])
        let right = this.fromDisplayPrice(limits[1])
        return (await left < await right) ?
            [await left, await right] :
            [await right, await left]
    }

    private async untransformLimits (limits: PriceRange): Promise<PriceRange> {
        let left = this.toDisplayPrice(limits[0])
        let right = this.toDisplayPrice(limits[1])
        return (await left < await right) ?
            [await left, await right] :
            [await right, await left]
    }

    private async mintRange (qty: TokenQty, isQtyBase: boolean, 
        range: TickRange, limits: PriceRange, opts?: CrocLpOpts): Promise<TransactionResponse> {
        const saneLimits = await this.boundLimits(range, limits)

        let msgVal = this.msgValRange(qty, isQtyBase, range, await saneLimits, opts)
        let weiQty = this.normQty(qty, isQtyBase)
        let [lowerBound, upperBound] = await this.transformLimits(await saneLimits)
        
        const calldata = (await this.makeEncoder()).encodeMintConc(range[0], range[1],
            await weiQty, isQtyBase, lowerBound, upperBound, this.maskSurplusFlag(opts))
        return this.sendCmd(calldata, { value: await msgVal })
    }

    private maskSurplusFlag (opts?: CrocLpOpts): number {
        if (!opts || opts.surplus === undefined) { return this.maskSurplusFlag({surplus: false})}
        return encodeSurplusArg(opts.surplus, this.useTrueBase)
    }

    private async msgValAmbient (qty: TokenQty, isQtyBase: boolean, limits: PriceRange, 
        opts?: CrocLpOpts): Promise<BigNumber> {
        if (!this.needsAttachedVal(opts)) { return BigNumber.from(0) }
        let ethQty = isQtyBase ? qty :
            this.ethForAmbientQuote(qty, limits)
        return this.normEth(await ethQty)
    }

    private async msgValRange (qty: TokenQty, isQtyBase: boolean, range: TickRange, 
        limits: PriceRange, opts?: CrocLpOpts): Promise<BigNumber> {
        if (!this.needsAttachedVal(opts)) { return BigNumber.from(0) }
        let ethQty = isQtyBase ? qty :
            this.ethForRangeQuote(qty, range, limits)
        return this.normEth(await ethQty)
    }

    private needsAttachedVal (opts?: CrocLpOpts): boolean {
        if (this.baseToken === ethers.constants.AddressZero) {
            let flags = this.maskSurplusFlag(opts)
            return !(decodeSurplusFlag(flags)[0])
        }
        return false
    }

    private async ethForAmbientQuote (quoteQty: TokenQty, limits: PriceRange): Promise<TokenQty> {
        const weiEth = this.calcEthInQuote(quoteQty, limits)
        return toDisplayQty(await weiEth, await this.baseDecimals)
    }

    private async calcEthInQuote (quoteQty: TokenQty, limits: PriceRange, 
        precAdj: number = 1.001): Promise<number> {
        const weiQty = await this.normQty(quoteQty, false);
        const [, boundPrice] = await this.transformLimits(limits)
        return Math.round(bigNumToFloat(weiQty) * boundPrice * precAdj)            
    }

    private async ethForRangeQuote (quoteQty: TokenQty, range: TickRange, 
        limits: PriceRange): Promise<TokenQty> {        
        const [, boundPrice] = await this.transformLimits(limits)
        const [lowerPrice, upperPrice] = this.rangeToPrice(range)

        let skew = concDepositSkew(boundPrice, lowerPrice, upperPrice)
        let ambiQty = this.calcEthInQuote(quoteQty, limits)
        let concQty = ambiQty.then(aq => Math.ceil(aq * skew))

        return toDisplayQty(await concQty, await this.baseDecimals)
    }

    private async normEth (ethQty: TokenQty): Promise<BigNumber> {
        return this.normQty(ethQty, true) // ETH is always on base side
    }

    private async normQty (qty: TokenQty, isBase: boolean): Promise<BigNumber> {
        let token = isBase ? this.baseTokenView : this.quoteTokenView
        return token.normQty(qty)
    }

    private async makeEncoder(): Promise<WarmPathEncoder> {
        return new WarmPathEncoder(this.baseToken, this.quoteToken, (await this.context).chain.poolIndex)
    }

    readonly baseToken: string
    readonly quoteToken: string
    readonly baseTokenView: CrocTokenView
    readonly quoteTokenView: CrocTokenView
    readonly baseDecimals: Promise<number>
    readonly quoteDecimals: Promise<number>
    readonly useTrueBase: boolean
    readonly context: Promise<CrocContext>
}

export interface CrocLpOpts {
    surplus?: CrocSurplusFlags
}
