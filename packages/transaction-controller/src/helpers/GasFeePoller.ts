import EthQuery from '@metamask/eth-query';
import type { GasFeeState } from '@metamask/gas-fee-controller';
import type { NetworkClientId, Provider } from '@metamask/network-controller';
import type { Hex } from '@metamask/utils';
import { createModuleLogger } from '@metamask/utils';
import EventEmitter from 'events';

import { projectLogger } from '../logger';
import type {
  GasFeeEstimates,
  GasFeeFlow,
  GasFeeFlowRequest,
  Layer1GasFeeFlow,
} from '../types';
import { TransactionStatus, type TransactionMeta } from '../types';
import { getGasFeeFlow } from '../utils/gas-flow';
import { getTransactionLayer1GasFee } from '../utils/layer1-gas-fee-flow';

const log = createModuleLogger(projectLogger, 'gas-fee-poller');

const INTERVAL_MILLISECONDS = 10000;

/**
 * Automatically polls and updates suggested gas fees on unapproved transactions.
 */
export class GasFeePoller {
  hub: EventEmitter = new EventEmitter();

  #gasFeeFlows: GasFeeFlow[];

  #getGasFeeControllerEstimates: () => Promise<GasFeeState>;

  #getProvider: (chainId: Hex, networkClientId?: NetworkClientId) => Provider;

  #getTransactions: () => TransactionMeta[];

  #layer1GasFeeFlows: Layer1GasFeeFlow[];

  #timeout: ReturnType<typeof setTimeout> | undefined;

  #running = false;

  /**
   * Constructs a new instance of the GasFeePoller.
   * @param options - The options for this instance.
   * @param options.gasFeeFlows - The gas fee flows to use to obtain suitable gas fees.
   * @param options.getGasFeeControllerEstimates - Callback to obtain the default fee estimates.
   * @param options.getProvider - Callback to obtain a provider instance.
   * @param options.getTransactions - Callback to obtain the transaction data.
   * @param options.layer1GasFeeFlows - The layer 1 gas fee flows to use to obtain suitable layer 1 gas fees.
   * @param options.onStateChange - Callback to register a listener for controller state changes.
   */
  constructor({
    gasFeeFlows,
    getGasFeeControllerEstimates,
    getProvider,
    getTransactions,
    layer1GasFeeFlows,
    onStateChange,
  }: {
    gasFeeFlows: GasFeeFlow[];
    getGasFeeControllerEstimates: () => Promise<GasFeeState>;
    getProvider: (chainId: Hex, networkClientId?: NetworkClientId) => Provider;
    getTransactions: () => TransactionMeta[];
    layer1GasFeeFlows: Layer1GasFeeFlow[];
    onStateChange: (listener: () => void) => void;
  }) {
    this.#gasFeeFlows = gasFeeFlows;
    this.#layer1GasFeeFlows = layer1GasFeeFlows;
    this.#getGasFeeControllerEstimates = getGasFeeControllerEstimates;
    this.#getProvider = getProvider;
    this.#getTransactions = getTransactions;

    onStateChange(() => {
      const unapprovedTransactions = this.#getUnapprovedTransactions();

      if (unapprovedTransactions.length) {
        this.#start();
      } else {
        this.#stop();
      }
    });
  }

  #start() {
    if (this.#running) {
      return;
    }

    // Intentionally not awaiting since this starts the timeout chain.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.#onTimeout();

    this.#running = true;

    log('Started polling');
  }

  #stop() {
    if (!this.#running) {
      return;
    }

    clearTimeout(this.#timeout);

    this.#timeout = undefined;
    this.#running = false;

    log('Stopped polling');
  }

  async #onTimeout() {
    await this.#updateUnapprovedTransactions();

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.#timeout = setTimeout(() => this.#onTimeout(), INTERVAL_MILLISECONDS);
  }

  async #updateUnapprovedTransactions() {
    const unapprovedTransactions = this.#getUnapprovedTransactions();

    if (unapprovedTransactions.length) {
      log('Found unapproved transactions', unapprovedTransactions.length);
    }

    await Promise.all(
      unapprovedTransactions.flatMap((tx) =>
        this.#updateUnapprovedTransaction(tx),
      ),
    );
  }

  async #updateUnapprovedTransaction(transactionMeta: TransactionMeta) {
    const { id } = transactionMeta;

    const [gasFeeEstimatesResponse, layer1GasFee] = await Promise.all([
      this.#updateTransactionGasFeeEstimates(transactionMeta),
      this.#updateTransactionLayer1GasFee(transactionMeta),
    ]);

    if (!gasFeeEstimatesResponse && !layer1GasFee) {
      return;
    }

    this.hub.emit('transaction-updated', {
      transactionId: id,
      gasFeeEstimates: gasFeeEstimatesResponse?.gasFeeEstimates,
      gasFeeEstimatesLoaded: gasFeeEstimatesResponse?.gasFeeEstimatesLoaded,
      layer1GasFee,
    });
  }

  async #updateTransactionGasFeeEstimates(
    transactionMeta: TransactionMeta,
  ): Promise<
    | { gasFeeEstimates?: GasFeeEstimates; gasFeeEstimatesLoaded: boolean }
    | undefined
  > {
    const { chainId, networkClientId } = transactionMeta;

    const ethQuery = new EthQuery(this.#getProvider(chainId, networkClientId));
    const gasFeeFlow = getGasFeeFlow(transactionMeta, this.#gasFeeFlows);

    if (gasFeeFlow) {
      log(
        'Found gas fee flow',
        gasFeeFlow.constructor.name,
        transactionMeta.id,
      );
    }

    const request: GasFeeFlowRequest = {
      ethQuery,
      getGasFeeControllerEstimates: this.#getGasFeeControllerEstimates,
      transactionMeta,
    };

    let gasFeeEstimates: GasFeeEstimates | undefined;

    if (gasFeeFlow) {
      try {
        const response = await gasFeeFlow.getGasFees(request);
        gasFeeEstimates = response.estimates;
      } catch (error) {
        log('Failed to get suggested gas fees', transactionMeta.id, error);
      }
    }

    if (!gasFeeEstimates && transactionMeta.gasFeeEstimatesLoaded) {
      return undefined;
    }

    log('Updated gas fee estimates', {
      gasFeeEstimates,
      transaction: transactionMeta.id,
    });

    return { gasFeeEstimates, gasFeeEstimatesLoaded: true };
  }

  async #updateTransactionLayer1GasFee(
    transactionMeta: TransactionMeta,
  ): Promise<Hex | undefined> {
    const { chainId, networkClientId } = transactionMeta;
    const provider = this.#getProvider(chainId, networkClientId);

    const layer1GasFee = await getTransactionLayer1GasFee({
      layer1GasFeeFlows: this.#layer1GasFeeFlows,
      provider,
      transactionMeta,
    });

    if (layer1GasFee) {
      log('Updated layer 1 gas fee', layer1GasFee, transactionMeta.id);
    }

    return layer1GasFee;
  }

  #getUnapprovedTransactions() {
    return this.#getTransactions().filter(
      (tx) => tx.status === TransactionStatus.unapproved,
    );
  }
}
