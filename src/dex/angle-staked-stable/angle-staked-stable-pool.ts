import { Interface } from '@ethersproject/abi';
import { DeepReadonly } from 'ts-essentials';
import { Address, BlockHeader, DexConfigMap, Log, Logger } from '../../types';
import {
  bigIntify,
  catchParseLogError,
  currentBigIntTimestampInS,
} from '../../utils';
import { StatefulEventSubscriber } from '../../stateful-event-subscriber';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { DexParams, PoolState } from './types';
import StakedStableABI from '../../abi/angle/stagToken.json';

export class AngleStakedStableEventPool extends StatefulEventSubscriber<PoolState> {
  handlers: {
    [event: string]: (
      event: any,
      state: DeepReadonly<PoolState>,
      log: Readonly<Log>,
      blockHeader: Readonly<BlockHeader>,
    ) => DeepReadonly<PoolState> | null;
  } = {};

  static angleStakedStableIface = new Interface(StakedStableABI);

  logDecoder: (log: Log) => any;

  addressesSubscribed: string[];

  BASE_27 = BigInt(1e27);
  HALF_BASE_27 = BigInt(1e27 / 2);
  ZERO = BigInt(0);

  constructor(
    readonly parentName: string,
    protected network: number,
    protected dexHelper: IDexHelper,
    logger: Logger,
    protected config: DexParams, // TODO: add any additional params required for event subscriber
  ) {
    // TODO: Add pool name
    super(parentName, 'Staked_Stable', dexHelper, logger);

    // TODO: make logDecoder decode logs that
    this.logDecoder = (log: Log) =>
      AngleStakedStableEventPool.angleStakedStableIface.parseLog(log);
    this.addressesSubscribed = [config.stEUR];

    // Add handlers
    this.handlers['Accrued'] = this.handleAccrued.bind(this);
    this.handlers['Deposit'] = this.handleDeposit.bind(this);
    this.handlers['Withdraw'] = this.handleWithdraw.bind(this);
    this.handlers['ToggledPause'] = this.handleToggledPause.bind(this);
    this.handlers['RateUpdated'] = this.handleRateUpdated.bind(this);
  }

  /**
   * The function is called every time any of the subscribed
   * addresses release log. The function accepts the current
   * state, updates the state according to the log, and returns
   * the updated state.
   * @param state - Current state of event subscriber
   * @param log - Log released by one of the subscribed addresses
   * @returns Updates state of the event subscriber after the log
   */
  protected processLog(
    state: DeepReadonly<PoolState>,
    log: Readonly<Log>,
    blockHeader: Readonly<BlockHeader>,
  ): DeepReadonly<PoolState> | null {
    try {
      const event = this.logDecoder(log);
      if (event.name in this.handlers) {
        return this.handlers[event.name](event, state, log, blockHeader);
      }
    } catch (e) {
      catchParseLogError(e, this.logger);
    }

    return null;
  }

  /**
   * The function generates state using on-chain calls. This
   * function is called to regenerate state if the event based
   * system fails to fetch events and the local state is no
   * more correct.
   * @param blockNumber - Blocknumber for which the state should
   * should be generated
   * @returns state of the event subscriber at blocknumber
   */
  async generateState(blockNumber: number): Promise<DeepReadonly<PoolState>> {
    // TODO: complete me!
    let poolState = {
      totalAssets: 0n,
      totalSupply: 0n,
      lastUpdate: 0n,
      paused: false,
      rate: 0n,
    } as PoolState;

    const multicall = [
      {
        target: this.config.stEUR,
        callData:
          AngleStakedStableEventPool.angleStakedStableIface.encodeFunctionData(
            'totalAssets',
          ),
      },
      {
        target: this.config.stEUR,
        callData:
          AngleStakedStableEventPool.angleStakedStableIface.encodeFunctionData(
            'totalSupply',
          ),
      },
      {
        target: this.config.stEUR,
        callData:
          AngleStakedStableEventPool.angleStakedStableIface.encodeFunctionData(
            'lastUpdate',
          ),
      },
      {
        target: this.config.stEUR,
        callData:
          AngleStakedStableEventPool.angleStakedStableIface.encodeFunctionData(
            'paused',
          ),
      },
    ];

    // on chain call
    const returnData = (
      await this.dexHelper.multiContract.methods
        .aggregate(multicall)
        .call({}, blockNumber)
    ).returnData;

    // Decode
    poolState.totalAssets = bigIntify(
      AngleStakedStableEventPool.angleStakedStableIface.decodeFunctionResult(
        'totalAssets',
        returnData[0],
      )[0],
    );
    poolState.totalSupply = bigIntify(
      AngleStakedStableEventPool.angleStakedStableIface.decodeFunctionResult(
        'totalSupply',
        returnData[1],
      )[0],
    );
    poolState.lastUpdate = bigIntify(
      AngleStakedStableEventPool.angleStakedStableIface.decodeFunctionResult(
        'lastUpdate',
        returnData[2],
      )[0],
    );
    poolState.paused =
      AngleStakedStableEventPool.angleStakedStableIface.decodeFunctionResult(
        'paused',
        returnData[3],
      )[0] as boolean;

    return poolState;
  }

  getRateDeposit(amount: bigint, state: PoolState): bigint {
    // TODO should not be needed if events are taken in the order triggered
    const newTotalAssets = this._accrue(state);
    return amount == 0n || state.totalSupply == 0n
      ? amount
      : (amount * state.totalSupply) / newTotalAssets;
  }

  getRateMint(shares: bigint, state: PoolState): bigint {
    // TODO should not be needed
    const newTotalAssets = this._accrue(state);
    const roundUp =
      (shares * newTotalAssets) % state.totalSupply > 0n ? 1n : 0n;
    return state.totalSupply == 0n
      ? shares
      : (shares * newTotalAssets) / state.totalSupply + roundUp;
  }

  getRateRedeem(shares: bigint, state: PoolState): bigint {
    // TODO should not be needed
    const newTotalAssets = this._accrue(state);
    return state.totalSupply == 0n
      ? shares
      : (shares * newTotalAssets) / state.totalSupply;
  }

  getRateWithdraw(amount: bigint, state: PoolState): bigint {
    // TODO should not be needed
    const newTotalAssets = this._accrue(state);
    const roundUp =
      (amount * state.totalSupply) % newTotalAssets > 0n ? 1n : 0n;
    return amount == 0n || state.totalSupply == 0n
      ? amount
      : (amount * state.totalSupply) / newTotalAssets + roundUp;
  }

  _accrue(state: PoolState): bigint {
    const newTotalAssets = this._computeUpdatedAssets(
      state.totalAssets,
      state.rate,
      currentBigIntTimestampInS() - state.lastUpdate,
    );
    return newTotalAssets;
  }

  _computeUpdatedAssets(amount: bigint, rate: bigint, exp: bigint): bigint {
    if (exp == 0n || rate > 0) return amount;
    const expMinusOne = exp - 1n;
    const expMinusTwo = exp > 2n ? exp - 2n : 0n;
    const basePowerTwo = (rate * rate + this.HALF_BASE_27) / this.BASE_27;
    const basePowerThree =
      (basePowerTwo * rate + this.HALF_BASE_27) / this.BASE_27;
    const secondTerm = (exp * expMinusOne * basePowerTwo) / 2n;
    const thirdTerm = (exp * expMinusOne * expMinusTwo * basePowerThree) / 6n;
    return (
      (amount * (this.BASE_27 + rate * exp + secondTerm + thirdTerm)) /
      this.BASE_27
    );
  }

  handleAccrued(
    event: any,
    state: PoolState,
    log: Readonly<Log>,
    blockHeader: BlockHeader,
  ): DeepReadonly<PoolState> | null {
    const interest = bigIntify(event.args.interest);
    state.totalAssets += interest;
    state.lastUpdate = bigIntify(blockHeader.timestamp);
    return state;
  }

  handleRateUpdated(
    event: any,
    state: PoolState,
    log: Readonly<Log>,
    blockHeader: BlockHeader,
  ): DeepReadonly<PoolState> | null {
    state.lastUpdate = bigIntify(blockHeader.timestamp);
    return state;
  }

  handleDeposit(
    event: any,
    state: PoolState,
    log: Readonly<Log>,
    blockHeader: BlockHeader,
  ): DeepReadonly<PoolState> | null {
    const assets = bigIntify(event.args.assets);
    const shares = bigIntify(event.args.shares);
    state.totalAssets += assets;
    state.totalSupply += shares;
    state.lastUpdate = bigIntify(blockHeader.timestamp);
    return state;
  }

  handleWithdraw(
    event: any,
    state: PoolState,
    log: Readonly<Log>,
    blockHeader: BlockHeader,
  ): DeepReadonly<PoolState> | null {
    const assets = bigIntify(event.args.assets);
    const shares = bigIntify(event.args.shares);
    state.totalAssets -= assets;
    state.totalSupply -= shares;
    state.lastUpdate = bigIntify(blockHeader.timestamp);
    return state;
  }

  handleToggledPause(
    event: any,
    state: PoolState,
    log: Readonly<Log>,
  ): DeepReadonly<PoolState> | null {
    const pauseStatus: boolean = event.args.pauseStatus;
    state.paused = pauseStatus;
    return state;
  }
}
