import type { LogDescription } from '@ethersproject/abi';
import { Interface } from '@ethersproject/abi';

import {
  SimulationInvalidResponseError,
  SimulationRevertedError,
} from '../errors';
import { SimulationErrorCode, SimulationTokenStandard } from '../types';
import {
  getSimulationData,
  SupportedToken,
  type GetSimulationDataRequest,
} from './simulation';
import type { SimulationResponseLog } from './simulation-api';
import {
  simulateTransactions,
  type SimulationResponse,
} from './simulation-api';

jest.mock('./simulation-api');

const USER_ADDRESS_MOCK = '0x123';
const OTHER_ADDRESS_MOCK = '0x456';
const CONTRACT_ADDRESS_MOCK = '0x789';
const BALANCE_1_MOCK = '0x0';
const BALANCE_2_MOCK = '0x1';
const DIFFERENCE_MOCK = '0x1';
const VALUE_MOCK = '0x4';
const TOKEN_ID_MOCK = '0x5';
const OTHER_TOKEN_ID_MOCK = '0x6';
const ERROR_CODE_MOCK = 123;
const ERROR_MESSAGE_MOCK = 'Test Error';

const REQUEST_MOCK: GetSimulationDataRequest = {
  chainId: '0x1',
  from: USER_ADDRESS_MOCK,
};

const PARSED_ERC20_TRANSFER_EVENT_MOCK = {
  name: 'Transfer',
  contractAddress: CONTRACT_ADDRESS_MOCK,
  args: [
    OTHER_ADDRESS_MOCK,
    USER_ADDRESS_MOCK,
    { toHexString: () => VALUE_MOCK },
  ],
} as unknown as LogDescription;

const PARSED_ERC721_TRANSFER_EVENT_MOCK = {
  name: 'Transfer',
  contractAddress: CONTRACT_ADDRESS_MOCK,
  args: [OTHER_ADDRESS_MOCK, USER_ADDRESS_MOCK, TOKEN_ID_MOCK],
} as unknown as LogDescription;

const PARSED_ERC1155_TRANSFER_SINGLE_EVENT_MOCK = {
  name: 'TransferSingle',
  contractAddress: CONTRACT_ADDRESS_MOCK,
  args: [
    OTHER_ADDRESS_MOCK,
    OTHER_ADDRESS_MOCK,
    USER_ADDRESS_MOCK,
    TOKEN_ID_MOCK,
    { toHexString: () => VALUE_MOCK },
  ],
} as unknown as LogDescription;

const PARSED_ERC1155_TRANSFER_BATCH_EVENT_MOCK = {
  name: 'TransferBatch',
  contractAddress: CONTRACT_ADDRESS_MOCK,
  args: [
    OTHER_ADDRESS_MOCK,
    OTHER_ADDRESS_MOCK,
    USER_ADDRESS_MOCK,
    [TOKEN_ID_MOCK],
    [{ toHexString: () => VALUE_MOCK }],
  ],
} as unknown as LogDescription;

const PARSED_WRAPPED_ERC20_DEPOSIT_EVENT_MOCK = {
  name: 'Deposit',
  contractAddress: CONTRACT_ADDRESS_MOCK,
  args: [USER_ADDRESS_MOCK, { toHexString: () => VALUE_MOCK }],
} as unknown as LogDescription;

const RESPONSE_NESTED_LOGS_MOCK: SimulationResponse = {
  transactions: [
    {
      return: '0x1',
      callTrace: {
        calls: [
          {
            calls: [
              {
                calls: [],
                logs: [createLogMock(CONTRACT_ADDRESS_MOCK)],
              },
            ],
            logs: [],
          },
        ],
        logs: [],
      },
      stateDiff: {
        pre: {},
        post: {},
      },
    },
  ],
};

/**
 * Create a mock of a raw log emitted by a simulated transaction.
 * @param contractAddress - The contract address.
 * @returns The raw log mock.
 */
function createLogMock(contractAddress: string) {
  return {
    address: contractAddress,
  } as unknown as SimulationResponseLog;
}

/**
 * Create a mock simulation API response to include event logs.
 * @param logs - The logs.
 * @returns Mock API response.
 */
function createEventResponseMock(logs: SimulationResponseLog[]) {
  return {
    transactions: [
      {
        return: '0x',
        callTrace: {
          calls: [],
          logs,
        },
        stateDiff: {
          pre: {},
          post: {},
        },
      },
    ],
  } as unknown as SimulationResponse;
}

/**
 * Create a mock API response for a native balance change.
 * @param previousBalance - The previous balance.
 * @param newBalance - The new balance.
 * @returns Mock API response.
 */
function createNativeBalanceResponse(
  previousBalance: string,
  newBalance: string,
) {
  return {
    transactions: [
      {
        callTrace: {
          calls: [],
          logs: [],
        },
        stateDiff: {
          pre: {
            [USER_ADDRESS_MOCK]: {
              balance: previousBalance,
            },
          },
          post: {
            [USER_ADDRESS_MOCK]: {
              balance: newBalance,
            },
          },
        },
      },
    ],
  } as unknown as SimulationResponse;
}

/**
 * Create a mock API response for a token balance balanceOf request.
 * @param previousBalances - The previous balance.
 * @param newBalances - The new balance.
 * @returns Mock API response.
 */
function createBalanceOfResponse(
  previousBalances: string[],
  newBalances: string[],
) {
  return {
    transactions: [
      ...previousBalances.map((previousBalance) => ({
        return: previousBalance,
        callTrace: {
          calls: [],
          logs: [],
        },
        stateDiff: {
          pre: {},
          post: {},
        },
      })),
      {
        return: '0x',
        callTrace: {
          calls: [],
          logs: [],
        },
        stateDiff: {
          pre: {},
          post: {},
        },
      },
      ...newBalances.map((newBalance) => ({
        return: newBalance,
        callTrace: {
          calls: [],
          logs: [],
        },
        stateDiff: {
          pre: {},
          post: {},
        },
      })),
    ],
  } as unknown as SimulationResponse;
}

/**
 * Mock the parsing of raw logs by the token ABIs.
 * @param options - The options to mock the parsing of logs.
 * @param options.erc20 - The parsed event with the ERC-20 ABI.
 * @param options.erc721 - The parsed event with the ERC-721 ABI.
 * @param options.erc1155 - The parsed event with the ERC-1155 ABI.
 * @param options.erc20Wrapped - The parsed event with the wrapped ERC-20 ABI.
 * @param options.erc721Legacy - The parsed event with the legacy ERC-721 ABI.
 */
function mockParseLog({
  erc20,
  erc721,
  erc1155,
  erc20Wrapped,
  erc721Legacy,
}: {
  erc20?: LogDescription;
  erc721?: LogDescription;
  erc1155?: LogDescription;
  erc20Wrapped?: LogDescription;
  erc721Legacy?: LogDescription;
}) {
  const parseLogMock = jest.spyOn(Interface.prototype, 'parseLog');

  for (const value of [erc20, erc721, erc1155, erc20Wrapped, erc721Legacy]) {
    if (value) {
      parseLogMock.mockReturnValueOnce(value);
      return;
    }

    parseLogMock.mockImplementationOnce(() => {
      throw new Error();
    });
  }
}

describe('Simulation Utils', () => {
  const simulateTransactionsMock = jest.mocked(simulateTransactions);

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(Interface.prototype, 'encodeFunctionData').mockReturnValue('');
  });

  describe('getSimulationData', () => {
    describe('returns native balance change', () => {
      it.each([
        ['increased', BALANCE_1_MOCK, BALANCE_2_MOCK, false],
        ['decreased', BALANCE_2_MOCK, BALANCE_1_MOCK, true],
      ])(
        'when balance %s',
        async (_title, previousBalance, newBalance, isDecrease) => {
          simulateTransactionsMock.mockResolvedValueOnce(
            createNativeBalanceResponse(previousBalance, newBalance),
          );

          const simulationData = await getSimulationData(REQUEST_MOCK);

          expect(simulationData).toStrictEqual({
            nativeBalanceChange: {
              difference: DIFFERENCE_MOCK,
              isDecrease,
              newBalance,
              previousBalance,
            },
            tokenBalanceChanges: [],
          });
        },
      );

      it('unless balance is unchanged', async () => {
        simulateTransactionsMock.mockResolvedValueOnce(
          createNativeBalanceResponse(BALANCE_1_MOCK, BALANCE_1_MOCK),
        );

        const simulationData = await getSimulationData(REQUEST_MOCK);

        expect(simulationData).toStrictEqual({
          nativeBalanceChange: undefined,
          tokenBalanceChanges: [],
        });
      });
    });

    describe('returns token balance changes', () => {
      it.each([
        {
          title: 'ERC-20 token',
          parsedEvent: PARSED_ERC20_TRANSFER_EVENT_MOCK,
          tokenType: SupportedToken.ERC20,
          tokenStandard: SimulationTokenStandard.erc20,
          tokenId: undefined,
          previousBalances: [BALANCE_1_MOCK],
          newBalances: [BALANCE_2_MOCK],
        },
        {
          title: 'ERC-721 token',
          parsedEvent: PARSED_ERC721_TRANSFER_EVENT_MOCK,
          tokenType: SupportedToken.ERC721,
          tokenStandard: SimulationTokenStandard.erc721,
          tokenId: TOKEN_ID_MOCK,
          previousBalances: [OTHER_ADDRESS_MOCK],
          newBalances: [USER_ADDRESS_MOCK],
        },
        {
          title: 'ERC-1155 token via single event',
          parsedEvent: PARSED_ERC1155_TRANSFER_SINGLE_EVENT_MOCK,
          tokenType: SupportedToken.ERC1155,
          tokenStandard: SimulationTokenStandard.erc1155,
          tokenId: TOKEN_ID_MOCK,
          previousBalances: [BALANCE_1_MOCK],
          newBalances: [BALANCE_2_MOCK],
        },
        {
          title: 'ERC-1155 token via batch event',
          parsedEvent: PARSED_ERC1155_TRANSFER_BATCH_EVENT_MOCK,
          tokenType: SupportedToken.ERC1155,
          tokenStandard: SimulationTokenStandard.erc1155,
          tokenId: TOKEN_ID_MOCK,
          previousBalances: [BALANCE_1_MOCK],
          newBalances: [BALANCE_2_MOCK],
        },
        {
          title: 'wrapped ERC-20 token',
          parsedEvent: PARSED_WRAPPED_ERC20_DEPOSIT_EVENT_MOCK,
          tokenType: SupportedToken.ERC20_WRAPPED,
          tokenStandard: SimulationTokenStandard.erc20,
          tokenId: undefined,
          previousBalances: [BALANCE_1_MOCK],
          newBalances: [BALANCE_2_MOCK],
        },
        {
          title: 'legacy ERC-721 token',
          parsedEvent: PARSED_ERC721_TRANSFER_EVENT_MOCK,
          tokenType: SupportedToken.ERC721_LEGACY,
          tokenStandard: SimulationTokenStandard.erc721,
          tokenId: TOKEN_ID_MOCK,
          previousBalances: [OTHER_ADDRESS_MOCK],
          newBalances: [USER_ADDRESS_MOCK],
        },
      ])(
        'on $title',
        async ({
          parsedEvent,
          tokenStandard,
          tokenType,
          tokenId,
          previousBalances,
          newBalances,
        }) => {
          mockParseLog({ [tokenType]: parsedEvent });

          simulateTransactionsMock
            .mockResolvedValueOnce(
              createEventResponseMock([createLogMock(CONTRACT_ADDRESS_MOCK)]),
            )
            .mockResolvedValueOnce(
              createBalanceOfResponse(previousBalances, newBalances),
            );

          const simulationData = await getSimulationData(REQUEST_MOCK);

          expect(simulationData).toStrictEqual({
            nativeBalanceChange: undefined,
            tokenBalanceChanges: [
              {
                standard: tokenStandard,
                address: CONTRACT_ADDRESS_MOCK,
                id: tokenId,
                previousBalance: BALANCE_1_MOCK,
                newBalance: BALANCE_2_MOCK,
                difference: DIFFERENCE_MOCK,
                isDecrease: false,
              },
            ],
          });
        },
      );

      it('on multiple different tokens', async () => {
        mockParseLog({
          erc20: PARSED_ERC20_TRANSFER_EVENT_MOCK,
        });

        mockParseLog({
          erc721: PARSED_ERC721_TRANSFER_EVENT_MOCK,
        });

        mockParseLog({
          erc1155: PARSED_ERC1155_TRANSFER_SINGLE_EVENT_MOCK,
        });

        simulateTransactionsMock
          .mockResolvedValueOnce(
            createEventResponseMock([
              createLogMock('0x7'),
              createLogMock('0x8'),
              createLogMock('0x9'),
            ]),
          )
          .mockResolvedValueOnce(
            createBalanceOfResponse(
              ['0x1', OTHER_ADDRESS_MOCK, '0x3'],
              ['0x6', USER_ADDRESS_MOCK, '0x4'],
            ),
          );

        const simulationData = await getSimulationData(REQUEST_MOCK);

        expect(simulationData).toStrictEqual({
          nativeBalanceChange: undefined,
          tokenBalanceChanges: [
            {
              standard: SimulationTokenStandard.erc20,
              address: '0x7',
              id: undefined,
              previousBalance: '0x1',
              newBalance: '0x6',
              difference: '0x5',
              isDecrease: false,
            },
            {
              standard: SimulationTokenStandard.erc721,
              address: '0x8',
              id: TOKEN_ID_MOCK,
              previousBalance: '0x0',
              newBalance: '0x1',
              difference: '0x1',
              isDecrease: false,
            },
            {
              standard: SimulationTokenStandard.erc1155,
              address: '0x9',
              id: TOKEN_ID_MOCK,
              previousBalance: '0x3',
              newBalance: '0x4',
              difference: '0x1',
              isDecrease: false,
            },
          ],
        });
      });

      it('with multiple events on same ERC-20 contract', async () => {
        mockParseLog({
          erc20: PARSED_ERC20_TRANSFER_EVENT_MOCK,
        });

        mockParseLog({
          erc20: PARSED_ERC20_TRANSFER_EVENT_MOCK,
        });

        simulateTransactionsMock
          .mockResolvedValueOnce(
            createEventResponseMock([
              createLogMock(CONTRACT_ADDRESS_MOCK),
              createLogMock(CONTRACT_ADDRESS_MOCK),
            ]),
          )
          .mockResolvedValueOnce(
            createBalanceOfResponse([BALANCE_2_MOCK], [BALANCE_1_MOCK]),
          );

        const simulationData = await getSimulationData(REQUEST_MOCK);

        expect(simulationData).toStrictEqual({
          nativeBalanceChange: undefined,
          tokenBalanceChanges: [
            {
              standard: SimulationTokenStandard.erc20,
              address: CONTRACT_ADDRESS_MOCK,
              id: undefined,
              previousBalance: BALANCE_2_MOCK,
              newBalance: BALANCE_1_MOCK,
              difference: DIFFERENCE_MOCK,
              isDecrease: true,
            },
          ],
        });
      });

      it('with multiple events on same ERC-721 contract', async () => {
        mockParseLog({
          erc721: PARSED_ERC721_TRANSFER_EVENT_MOCK,
        });

        mockParseLog({
          erc721: {
            ...PARSED_ERC721_TRANSFER_EVENT_MOCK,
            args: [OTHER_ADDRESS_MOCK, USER_ADDRESS_MOCK, OTHER_TOKEN_ID_MOCK],
          },
        });

        simulateTransactionsMock
          .mockResolvedValueOnce(
            createEventResponseMock([
              createLogMock(CONTRACT_ADDRESS_MOCK),
              createLogMock(CONTRACT_ADDRESS_MOCK),
            ]),
          )
          .mockResolvedValueOnce(
            createBalanceOfResponse(
              [OTHER_ADDRESS_MOCK, OTHER_ADDRESS_MOCK],
              [USER_ADDRESS_MOCK, USER_ADDRESS_MOCK],
            ),
          );

        const simulationData = await getSimulationData(REQUEST_MOCK);

        expect(simulationData).toStrictEqual({
          nativeBalanceChange: undefined,
          tokenBalanceChanges: [
            {
              standard: SimulationTokenStandard.erc721,
              address: CONTRACT_ADDRESS_MOCK,
              id: TOKEN_ID_MOCK,
              previousBalance: BALANCE_1_MOCK,
              newBalance: BALANCE_2_MOCK,
              difference: DIFFERENCE_MOCK,
              isDecrease: false,
            },
            {
              standard: SimulationTokenStandard.erc721,
              address: CONTRACT_ADDRESS_MOCK,
              id: OTHER_TOKEN_ID_MOCK,
              previousBalance: BALANCE_1_MOCK,
              newBalance: BALANCE_2_MOCK,
              difference: DIFFERENCE_MOCK,
              isDecrease: false,
            },
          ],
        });
      });

      it('on NFT mint', async () => {
        mockParseLog({
          erc721: {
            ...PARSED_ERC721_TRANSFER_EVENT_MOCK,
            args: [
              '0x0000000000000000000000000000000000000000',
              USER_ADDRESS_MOCK,
              TOKEN_ID_MOCK,
            ],
          },
        });

        simulateTransactionsMock
          .mockResolvedValueOnce(
            createEventResponseMock([createLogMock(CONTRACT_ADDRESS_MOCK)]),
          )
          .mockResolvedValueOnce(
            createBalanceOfResponse([], [USER_ADDRESS_MOCK]),
          );

        const simulationData = await getSimulationData(REQUEST_MOCK);

        expect(simulateTransactionsMock).toHaveBeenCalledTimes(2);
        // The second call should only simulate the minting of the NFT and
        // check the balance after, and not before.
        expect(simulateTransactionsMock).toHaveBeenNthCalledWith(
          2,
          REQUEST_MOCK.chainId,
          {
            transactions: [
              REQUEST_MOCK,
              {
                from: REQUEST_MOCK.from,
                to: CONTRACT_ADDRESS_MOCK,
                data: expect.any(String),
              },
            ],
          },
        );
        expect(simulationData).toStrictEqual({
          nativeBalanceChange: undefined,
          tokenBalanceChanges: [
            {
              standard: SimulationTokenStandard.erc721,
              address: CONTRACT_ADDRESS_MOCK,
              id: TOKEN_ID_MOCK,
              previousBalance: '0x0',
              newBalance: '0x1',
              difference: '0x1',
              isDecrease: false,
            },
          ],
        });
      });

      it('as empty if events cannot be parsed', async () => {
        mockParseLog({});

        simulateTransactionsMock
          .mockResolvedValueOnce(
            createEventResponseMock([createLogMock(CONTRACT_ADDRESS_MOCK)]),
          )
          .mockResolvedValueOnce(
            createBalanceOfResponse([BALANCE_1_MOCK], [BALANCE_2_MOCK]),
          );

        const simulationData = await getSimulationData(REQUEST_MOCK);

        expect(simulationData).toStrictEqual({
          nativeBalanceChange: undefined,
          tokenBalanceChanges: [],
        });
      });

      it('as empty if events are not impacting user', async () => {
        mockParseLog({
          erc20: {
            ...PARSED_ERC20_TRANSFER_EVENT_MOCK,
            args: [
              OTHER_ADDRESS_MOCK,
              OTHER_ADDRESS_MOCK,
              { toHexString: () => VALUE_MOCK },
            ],
          },
        });

        simulateTransactionsMock.mockResolvedValueOnce(
          createEventResponseMock([createLogMock(CONTRACT_ADDRESS_MOCK)]),
        );

        const simulationData = await getSimulationData(REQUEST_MOCK);

        expect(simulationData).toStrictEqual({
          nativeBalanceChange: undefined,
          tokenBalanceChanges: [],
        });
      });

      it('as empty if balance has not changed', async () => {
        mockParseLog({
          erc20: PARSED_ERC20_TRANSFER_EVENT_MOCK,
        });

        simulateTransactionsMock
          .mockResolvedValueOnce(
            createEventResponseMock([createLogMock(CONTRACT_ADDRESS_MOCK)]),
          )
          .mockResolvedValueOnce(
            createBalanceOfResponse([BALANCE_1_MOCK], [BALANCE_1_MOCK]),
          );

        const simulationData = await getSimulationData(REQUEST_MOCK);

        expect(simulationData).toStrictEqual({
          nativeBalanceChange: undefined,
          tokenBalanceChanges: [],
        });
      });

      it('using logs from nested calls', async () => {
        mockParseLog({ erc20: PARSED_ERC20_TRANSFER_EVENT_MOCK });

        simulateTransactionsMock
          .mockResolvedValueOnce(RESPONSE_NESTED_LOGS_MOCK)
          .mockResolvedValueOnce(
            createBalanceOfResponse([BALANCE_1_MOCK], [BALANCE_2_MOCK]),
          );

        const simulationData = await getSimulationData(REQUEST_MOCK);

        expect(simulationData).toStrictEqual({
          nativeBalanceChange: undefined,
          tokenBalanceChanges: [
            {
              standard: SimulationTokenStandard.erc20,
              address: CONTRACT_ADDRESS_MOCK,
              id: undefined,
              previousBalance: BALANCE_1_MOCK,
              newBalance: BALANCE_2_MOCK,
              difference: DIFFERENCE_MOCK,
              isDecrease: false,
            },
          ],
        });
      });
    });

    describe('returns error', () => {
      it('if API request throws', async () => {
        simulateTransactionsMock.mockRejectedValueOnce({
          code: ERROR_CODE_MOCK,
          message: ERROR_MESSAGE_MOCK,
        });

        expect(await getSimulationData(REQUEST_MOCK)).toStrictEqual({
          error: {
            code: ERROR_CODE_MOCK,
            message: ERROR_MESSAGE_MOCK,
          },
          tokenBalanceChanges: [],
        });
      });

      it('if API request throws without message', async () => {
        simulateTransactionsMock.mockRejectedValueOnce({
          code: ERROR_CODE_MOCK,
        });

        expect(await getSimulationData(REQUEST_MOCK)).toStrictEqual({
          error: {
            code: ERROR_CODE_MOCK,
            message: undefined,
          },
          tokenBalanceChanges: [],
        });
      });

      it('if API response has missing transactions', async () => {
        mockParseLog({ erc20: PARSED_ERC20_TRANSFER_EVENT_MOCK });

        simulateTransactionsMock
          .mockResolvedValueOnce(
            createEventResponseMock([createLogMock(CONTRACT_ADDRESS_MOCK)]),
          )
          .mockResolvedValueOnce(createBalanceOfResponse([], []));

        const simulationData = await getSimulationData(REQUEST_MOCK);

        expect(simulationData).toStrictEqual({
          error: {
            code: SimulationErrorCode.InvalidResponse,
            message: new SimulationInvalidResponseError().message,
          },
          tokenBalanceChanges: [],
        });
      });

      it('if API response has transaction revert error', async () => {
        simulateTransactionsMock.mockResolvedValueOnce({
          transactions: [
            {
              error: 'test execution reverted test',
              return: '0x',
            },
          ],
        });

        const simulationData = await getSimulationData(REQUEST_MOCK);

        expect(simulationData).toStrictEqual({
          error: {
            code: SimulationErrorCode.Reverted,
            message: new SimulationRevertedError().message,
          },
          tokenBalanceChanges: [],
        });
      });

      it('if API response has transaction error', async () => {
        simulateTransactionsMock.mockResolvedValueOnce({
          transactions: [
            {
              error: 'test 1 2 3',
              return: '0x',
            },
          ],
        });

        const simulationData = await getSimulationData(REQUEST_MOCK);

        expect(simulationData).toStrictEqual({
          error: {
            code: undefined,
            message: 'test 1 2 3',
          },
          tokenBalanceChanges: [],
        });
      });

      it('if API response has insufficient gas error', async () => {
        simulateTransactionsMock.mockRejectedValueOnce({
          code: ERROR_CODE_MOCK,
          message: 'test insufficient funds for gas test',
        });

        const simulationData = await getSimulationData(REQUEST_MOCK);

        expect(simulationData).toStrictEqual({
          error: {
            code: SimulationErrorCode.Reverted,
            message: new SimulationRevertedError().message,
          },
          tokenBalanceChanges: [],
        });
      });
    });
  });
});
