import { EventEmitter } from 'events';
import { v1 as random } from 'uuid';
import { Mutex } from 'async-mutex';
import BaseController, { BaseConfig, BaseState } from '../BaseController';
import type { PreferencesState } from '../user/PreferencesController';
import type { NetworkState, NetworkType } from '../network/NetworkController';
import {
  safelyExecute,
  handleFetch,
  validateTokenToWatch,
  toChecksumHexAddress,
} from '../util';
import { MAINNET } from '../constants';
import type { Token } from './TokenRatesController';
import type {
  ApiCollectible,
  ApiCollectibleCreator,
  ApiCollectibleContract,
  ApiCollectibleLastSale,
} from './AssetsDetectionController';
import type { AssetsContractController } from './AssetsContractController';
import { compareCollectiblesMetadata } from './assetsUtil';

/**
 * @type Collectible
 *
 * Collectible representation
 *
 * @property address - Hex address of a ERC721 contract
 * @property description - The collectible description
 * @property image - URI of custom collectible image associated with this tokenId
 * @property name - Name associated with this tokenId and contract address
 * @property tokenId - The collectible identifier
 * @property numberOfSales - Number of sales
 * @property backgroundColor - The background color to be displayed with the item
 * @property imagePreview - URI of a smaller image associated with this collectible
 * @property imageThumbnail - URI of a thumbnail image associated with this collectible
 * @property imageOriginal - URI of the original image associated with this collectible
 * @property animation - URI of a animation associated with this collectible
 * @property animationOriginal - URI of the original animation associated with this collectible
 * @property externalLink - External link containing additional information
 * @property creator - The collectible owner information object
 */
export interface Collectible extends CollectibleMetadata {
  tokenId: number;
  address: string;
}

/**
 * @type CollectibleContract
 *
 * Collectible contract information representation
 *
 * @property name - Contract name
 * @property logo - Contract logo
 * @property address - Contract address
 * @property symbol - Contract symbol
 * @property description - Contract description
 * @property totalSupply - Total supply of collectibles
 * @property assetContractType - The collectible type, it could be `semi-fungible` or `non-fungible`
 * @property createdDate - Creation date
 * @property schemaName - The schema followed by the contract, it could be `ERC721` or `ERC1155`
 * @property externalLink - External link containing additional information
 */
export interface CollectibleContract {
  name?: string;
  logo?: string;
  address: string;
  symbol?: string;
  description?: string;
  totalSupply?: string;
  assetContractType?: string;
  createdDate?: string;
  schemaName?: string;
  externalLink?: string;
}

/**
 * @type CollectibleMetadata
 *
 * Collectible custom information
 *
 * @property name - Collectible custom name
 * @property description - The collectible description
 * @property numberOfSales - Number of sales
 * @property backgroundColor - The background color to be displayed with the item
 * @property image - Image custom image URI
 * @property imagePreview - URI of a smaller image associated with this collectible
 * @property imageThumbnail - URI of a thumbnail image associated with this collectible
 * @property imageOriginal - URI of the original image associated with this collectible
 * @property animation - URI of a animation associated with this collectible
 * @property animationOriginal - URI of the original animation associated with this collectible
 * @property externalLink - External link containing additional information
 * @property creator - The collectible owner information object
 */
export interface CollectibleMetadata {
  name?: string;
  description?: string;
  numberOfSales?: number;
  backgroundColor?: string;
  image?: string;
  imagePreview?: string;
  imageThumbnail?: string;
  imageOriginal?: string;
  animation?: string;
  animationOriginal?: string;
  externalLink?: string;
  creator?: ApiCollectibleCreator;
  lastSale?: ApiCollectibleLastSale;
}

/**
 * @type AssetsConfig
 *
 * Assets controller configuration
 *
 * @property networkType - Network ID as per net_version
 * @property selectedAddress - Vault selected address
 */
export interface AssetsConfig extends BaseConfig {
  networkType: NetworkType;
  selectedAddress: string;
  chainId: string;
}

/**
 * @type AssetSuggestionResult
 *
 * @property result - Promise resolving to a new suggested asset address
 * @property suggestedAssetMeta - Meta information about this new suggested asset
 */
export interface AssetSuggestionResult {
  result: Promise<string>;
  suggestedAssetMeta: SuggestedAssetMeta;
}

enum SuggestedAssetStatus {
  accepted = 'accepted',
  failed = 'failed',
  pending = 'pending',
  rejected = 'rejected',
}

type SuggestedAssetMetaBase = {
  id: string;
  time: number;
  type: string;
  asset: Token;
};

/**
 * @type SuggestedAssetMeta
 *
 * Suggested asset by EIP747 meta data
 *
 * @property error - Synthesized error information for failed asset suggestions
 * @property id - Generated UUID associated with this suggested asset
 * @property status - String status of this this suggested asset
 * @property time - Timestamp associated with this this suggested asset
 * @property type - Type type this suggested asset
 * @property asset - Asset suggested object
 */
export type SuggestedAssetMeta =
  | (SuggestedAssetMetaBase & {
      status: SuggestedAssetStatus.failed;
      error: Error;
    })
  | (SuggestedAssetMetaBase & {
      status:
        | SuggestedAssetStatus.accepted
        | SuggestedAssetStatus.rejected
        | SuggestedAssetStatus.pending;
    });

/**
 * @type AssetsState
 *
 * Assets controller state
 *
 * @property allTokens - Object containing tokens per account and network
 * @property allCollectibleContracts - Object containing collectibles contract information
 * @property allCollectibles - Object containing collectibles per account and network
 * @property collectibleContracts - List of collectibles contracts associated with the active vault
 * @property collectibles - List of collectibles associated with the active vault
 * @property suggestedAssets - List of suggested assets associated with the active vault
 * @property tokens - List of tokens associated with the active vault
 * @property ignoredTokens - List of tokens that should be ignored
 * @property ignoredCollectibles - List of collectibles that should be ignored
 */
export interface AssetsState extends BaseState {
  allTokens: { [key: string]: { [key: string]: Token[] } };
  allCollectibleContracts: {
    [key: string]: { [key: string]: CollectibleContract[] };
  };
  allCollectibles: { [key: string]: { [key: string]: Collectible[] } };
  collectibleContracts: CollectibleContract[];
  collectibles: Collectible[];
  ignoredTokens: Token[];
  ignoredCollectibles: Collectible[];
  suggestedAssets: SuggestedAssetMeta[];
  tokens: Token[];
}

/**
 * Controller that stores assets and exposes convenience methods
 */
export class AssetsController extends BaseController<
  AssetsConfig,
  AssetsState
> {
  private mutex = new Mutex();

  private getCollectibleApi(contractAddress: string, tokenId: number) {
    return `https://api.opensea.io/api/v1/asset/${contractAddress}/${tokenId}`;
  }

  private getCollectibleContractInformationApi(contractAddress: string) {
    return `https://api.opensea.io/api/v1/asset_contract/${contractAddress}`;
  }

  private failSuggestedAsset(
    suggestedAssetMeta: SuggestedAssetMeta,
    error: Error,
  ) {
    const failedSuggestedAssetMeta = {
      ...suggestedAssetMeta,
      status: SuggestedAssetStatus.failed,
      error,
    };
    this.hub.emit(
      `${suggestedAssetMeta.id}:finished`,
      failedSuggestedAssetMeta,
    );
  }

  /**
   * Request individual collectible information from OpenSea api
   *
   * @param contractAddress - Hex address of the collectible contract
   * @param tokenId - The collectible identifier
   * @returns - Promise resolving to the current collectible name and image
   */
  private async getCollectibleInformationFromApi(
    contractAddress: string,
    tokenId: number,
  ): Promise<CollectibleMetadata> {
    const tokenURI = this.getCollectibleApi(contractAddress, tokenId);
    let collectibleInformation: ApiCollectible;
    /* istanbul ignore if */
    if (this.openSeaApiKey) {
      collectibleInformation = await handleFetch(tokenURI, {
        headers: { 'X-API-KEY': this.openSeaApiKey },
      });
    } else {
      collectibleInformation = await handleFetch(tokenURI);
    }
    const {
      num_sales,
      background_color,
      image_url,
      image_preview_url,
      image_thumbnail_url,
      image_original_url,
      animation_url,
      animation_original_url,
      name,
      description,
      external_link,
      creator,
      last_sale,
    } = collectibleInformation;

    /* istanbul ignore next */
    const collectibleMetadata: CollectibleMetadata = Object.assign(
      {},
      { name },
      creator && { creator },
      description && { description },
      image_url && { image: image_url },
      num_sales && { numberOfSales: num_sales },
      background_color && { backgroundColor: background_color },
      image_preview_url && { imagePreview: image_preview_url },
      image_thumbnail_url && { imageThumbnail: image_thumbnail_url },
      image_original_url && { imageOriginal: image_original_url },
      animation_url && { animation: animation_url },
      animation_original_url && {
        animationOriginal: animation_original_url,
      },
      external_link && { externalLink: external_link },
      last_sale && { lastSale: last_sale },
    );

    return collectibleMetadata;
  }

  /**
   * Request individual collectible information from contracts that follows Metadata Interface
   *
   * @param contractAddress - Hex address of the collectible contract
   * @param tokenId - The collectible identifier
   * @returns - Promise resolving to the current collectible name and image
   */
  private async getCollectibleInformationFromTokenURI(
    contractAddress: string,
    tokenId: number,
  ): Promise<CollectibleMetadata> {
    const tokenURI = await this.getCollectibleTokenURI(
      contractAddress,
      tokenId,
    );
    const object = await handleFetch(tokenURI);
    const image = Object.prototype.hasOwnProperty.call(object, 'image')
      ? 'image'
      : /* istanbul ignore next */ 'image_url';
    return { image: object[image], name: object.name };
  }

  /**
   * Request individual collectible information (name, image url and description)
   *
   * @param contractAddress - Hex address of the collectible contract
   * @param tokenId - The collectible identifier
   * @returns - Promise resolving to the current collectible name and image
   */
  private async getCollectibleInformation(
    contractAddress: string,
    tokenId: number,
  ): Promise<CollectibleMetadata> {
    let information;
    // First try with OpenSea
    information = await safelyExecute(async () => {
      return await this.getCollectibleInformationFromApi(
        contractAddress,
        tokenId,
      );
    });
    if (information) {
      return information;
    }
    // Then following ERC721 standard
    information = await safelyExecute(async () => {
      return await this.getCollectibleInformationFromTokenURI(
        contractAddress,
        tokenId,
      );
    });
    /* istanbul ignore next */
    if (information) {
      return information;
    }
    /* istanbul ignore next */
    return {};
  }

  /**
   * Request collectible contract information from OpenSea api
   *
   * @param contractAddress - Hex address of the collectible contract
   * @returns - Promise resolving to the current collectible name and image
   */
  private async getCollectibleContractInformationFromApi(
    contractAddress: string,
  ): Promise<ApiCollectibleContract> {
    const api = this.getCollectibleContractInformationApi(contractAddress);
    let apiCollectibleContractObject: ApiCollectibleContract;
    /* istanbul ignore if */
    if (this.openSeaApiKey) {
      apiCollectibleContractObject = await handleFetch(api, {
        headers: { 'X-API-KEY': this.openSeaApiKey },
      });
    } else {
      apiCollectibleContractObject = await handleFetch(api);
    }
    return apiCollectibleContractObject;
  }

  /**
   * Request collectible contract information from the contract itself
   *
   * @param contractAddress - Hex address of the collectible contract
   * @returns - Promise resolving to the current collectible name and image
   */
  private async getCollectibleContractInformationFromContract(
    contractAddress: string,
  ): Promise<ApiCollectibleContract> {
    const name = await this.getAssetName(contractAddress);
    const symbol = await this.getAssetSymbol(contractAddress);
    return {
      name,
      symbol,
      address: contractAddress,
      asset_contract_type: null,
      created_date: null,
      schema_name: null,
      total_supply: null,
      description: null,
      external_link: null,
      image_url: null,
    };
  }

  /**
   * Request collectible contract information from OpenSea api
   *
   * @param contractAddress - Hex address of the collectible contract
   * @returns - Promise resolving to the collectible contract name, image and description
   */
  private async getCollectibleContractInformation(
    contractAddress: string,
  ): Promise<ApiCollectibleContract> {
    let information;
    // First try with OpenSea
    information = await safelyExecute(async () => {
      return await this.getCollectibleContractInformationFromApi(
        contractAddress,
      );
    });
    if (information) {
      return information;
    }
    // Then following ERC721 standard
    information = await safelyExecute(async () => {
      return await this.getCollectibleContractInformationFromContract(
        contractAddress,
      );
    });
    if (information) {
      return information;
    }
    /* istanbul ignore next */
    return {
      address: contractAddress,
      asset_contract_type: null,
      created_date: null,
      name: null,
      schema_name: null,
      symbol: null,
      total_supply: null,
      description: null,
      external_link: null,
      image_url: null,
    };
  }

  /**
   * Adds an individual collectible to the stored collectible list
   *
   * @param address - Hex address of the collectible contract
   * @param tokenId - The collectible identifier
   * @param opts - Collectible optional information (name, image and description)
   * @returns - Promise resolving to the current collectible list
   */
  private async addIndividualCollectible(
    address: string,
    tokenId: number,
    collectibleMetadata?: CollectibleMetadata,
  ): Promise<Collectible[]> {
    const releaseLock = await this.mutex.acquire();
    try {
      address = toChecksumHexAddress(address);
      const { allCollectibles, collectibles } = this.state;
      const { chainId, selectedAddress } = this.config;
      const existingEntry: Collectible | undefined = collectibles.find(
        (collectible) =>
          collectible.address === address && collectible.tokenId === tokenId,
      );
      /* istanbul ignore next */
      collectibleMetadata =
        collectibleMetadata ||
        (await this.getCollectibleInformation(address, tokenId));

      if (existingEntry) {
        const differentMetadata = compareCollectiblesMetadata(
          collectibleMetadata,
          existingEntry,
        );
        if (differentMetadata) {
          const indexToRemove = collectibles.findIndex(
            (collectible) =>
              collectible.address === address &&
              collectible.tokenId === tokenId,
          );
          /* istanbul ignore next */
          if (indexToRemove !== -1) {
            collectibles.splice(indexToRemove, 1);
          }
        } else {
          return collectibles;
        }
      }

      const newEntry: Collectible = {
        address,
        tokenId,
        ...collectibleMetadata,
      };
      const newCollectibles = [...collectibles, newEntry];
      const addressCollectibles = allCollectibles[selectedAddress];
      const newAddressCollectibles = {
        ...addressCollectibles,
        ...{ [chainId]: newCollectibles },
      };
      const newAllCollectibles = {
        ...allCollectibles,
        ...{ [selectedAddress]: newAddressCollectibles },
      };
      this.update({
        allCollectibles: newAllCollectibles,
        collectibles: newCollectibles,
      });
      return newCollectibles;
    } finally {
      releaseLock();
    }
  }

  /**
   * Adds a collectible contract to the stored collectible contracts list
   *
   * @param address - Hex address of the collectible contract
   * @param detection? - Whether the collectible is manually added or auto-detected
   * @returns - Promise resolving to the current collectible contracts list
   */
  private async addCollectibleContract(
    address: string,
    detection?: boolean,
  ): Promise<CollectibleContract[]> {
    const releaseLock = await this.mutex.acquire();
    try {
      address = toChecksumHexAddress(address);
      const { allCollectibleContracts, collectibleContracts } = this.state;
      const { chainId, selectedAddress } = this.config;
      const existingEntry = collectibleContracts.find(
        (collectibleContract) => collectibleContract.address === address,
      );
      if (existingEntry) {
        return collectibleContracts;
      }
      const contractInformation = await this.getCollectibleContractInformation(
        address,
      );
      const {
        asset_contract_type,
        created_date,
        name,
        schema_name,
        symbol,
        total_supply,
        description,
        external_link,
        image_url,
      } = contractInformation;
      // If being auto-detected opensea information is expected
      // Oherwise at least name and symbol from contract is needed
      if (
        (detection && !image_url) ||
        Object.keys(contractInformation).length === 0
      ) {
        return collectibleContracts;
      }
      /* istanbul ignore next */
      const newEntry: CollectibleContract = Object.assign(
        {},
        { address },
        description && { description },
        name && { name },
        image_url && { logo: image_url },
        symbol && { symbol },
        total_supply !== null && { totalSupply: total_supply },
        asset_contract_type && { assetContractType: asset_contract_type },
        created_date && { createdDate: created_date },
        schema_name && { schemaName: schema_name },
        external_link && { externalLink: external_link },
      );

      const newCollectibleContracts = [...collectibleContracts, newEntry];
      const addressCollectibleContracts =
        allCollectibleContracts[selectedAddress];
      const newAddressCollectibleContracts = {
        ...addressCollectibleContracts,
        ...{ [chainId]: newCollectibleContracts },
      };
      const newAllCollectibleContracts = {
        ...allCollectibleContracts,
        ...{ [selectedAddress]: newAddressCollectibleContracts },
      };
      this.update({
        allCollectibleContracts: newAllCollectibleContracts,
        collectibleContracts: newCollectibleContracts,
      });
      return newCollectibleContracts;
    } finally {
      releaseLock();
    }
  }

  /**
   * Removes an individual collectible from the stored token list and saves it in ignored collectibles list
   *
   * @param address - Hex address of the collectible contract
   * @param tokenId - Token identifier of the collectible
   */
  private removeAndIgnoreIndividualCollectible(
    address: string,
    tokenId: number,
  ) {
    address = toChecksumHexAddress(address);
    const { allCollectibles, collectibles, ignoredCollectibles } = this.state;
    const { chainId, selectedAddress } = this.config;
    const newIgnoredCollectibles = [...ignoredCollectibles];
    const newCollectibles = collectibles.filter((collectible) => {
      if (collectible.address === address && collectible.tokenId === tokenId) {
        const alreadyIgnored = newIgnoredCollectibles.find(
          (c) => c.address === address && c.tokenId === tokenId,
        );
        !alreadyIgnored && newIgnoredCollectibles.push(collectible);
        return false;
      }
      return true;
    });
    const addressCollectibles = allCollectibles[selectedAddress];
    const newAddressCollectibles = {
      ...addressCollectibles,
      ...{ [chainId]: newCollectibles },
    };
    const newAllCollectibles = {
      ...allCollectibles,
      ...{ [selectedAddress]: newAddressCollectibles },
    };
    this.update({
      allCollectibles: newAllCollectibles,
      collectibles: newCollectibles,
      ignoredCollectibles: newIgnoredCollectibles,
    });
  }

  /**
   * Removes an individual collectible from the stored token list
   *
   * @param address - Hex address of the collectible contract
   * @param tokenId - Token identifier of the collectible
   */
  private removeIndividualCollectible(address: string, tokenId: number) {
    address = toChecksumHexAddress(address);
    const { allCollectibles, collectibles } = this.state;
    const { chainId, selectedAddress } = this.config;
    const newCollectibles = collectibles.filter(
      (collectible) =>
        !(collectible.address === address && collectible.tokenId === tokenId),
    );
    const addressCollectibles = allCollectibles[selectedAddress];
    const newAddressCollectibles = {
      ...addressCollectibles,
      ...{ [chainId]: newCollectibles },
    };
    const newAllCollectibles = {
      ...allCollectibles,
      ...{ [selectedAddress]: newAddressCollectibles },
    };
    this.update({
      allCollectibles: newAllCollectibles,
      collectibles: newCollectibles,
    });
  }

  /**
   * Removes a collectible contract to the stored collectible contracts list
   *
   * @param address - Hex address of the collectible contract
   * @returns - Promise resolving to the current collectible contracts list
   */
  private removeCollectibleContract(address: string): CollectibleContract[] {
    address = toChecksumHexAddress(address);
    const { allCollectibleContracts, collectibleContracts } = this.state;
    const { chainId, selectedAddress } = this.config;
    const newCollectibleContracts = collectibleContracts.filter(
      (collectibleContract) => !(collectibleContract.address === address),
    );
    const addressCollectibleContracts =
      allCollectibleContracts[selectedAddress];
    const newAddressCollectibleContracts = {
      ...addressCollectibleContracts,
      ...{ [chainId]: newCollectibleContracts },
    };
    const newAllCollectibleContracts = {
      ...allCollectibleContracts,
      ...{ [selectedAddress]: newAddressCollectibleContracts },
    };
    this.update({
      allCollectibleContracts: newAllCollectibleContracts,
      collectibleContracts: newCollectibleContracts,
    });
    return newCollectibleContracts;
  }

  /**
   * EventEmitter instance used to listen to specific EIP747 events
   */
  hub = new EventEmitter();

  /**
   * Optional API key to use with opensea
   */
  openSeaApiKey?: string;

  /**
   * Name of this controller used during composition
   */
  name = 'AssetsController';

  private getAssetName: AssetsContractController['getAssetName'];

  private getAssetSymbol: AssetsContractController['getAssetSymbol'];

  private getCollectibleTokenURI: AssetsContractController['getCollectibleTokenURI'];

  /**
   * Creates a AssetsController instance
   *
   * @param options
   * @param options.onPreferencesStateChange - Allows subscribing to preference controller state changes
   * @param options.onNetworkStateChange - Allows subscribing to network controller state changes
   * @param options.getAssetName - Gets the name of the asset at the given address
   * @param options.getAssetSymbol - Gets the symbol of the asset at the given address
   * @param options.getCollectibleTokenURI - Gets the URI of the NFT at the given address, with the given ID
   * @param config - Initial options used to configure this controller
   * @param state - Initial state to set on this controller
   */
  constructor(
    {
      onPreferencesStateChange,
      onNetworkStateChange,
      getAssetName,
      getAssetSymbol,
      getCollectibleTokenURI,
    }: {
      onPreferencesStateChange: (
        listener: (preferencesState: PreferencesState) => void,
      ) => void;
      onNetworkStateChange: (
        listener: (networkState: NetworkState) => void,
      ) => void;
      getAssetName: AssetsContractController['getAssetName'];
      getAssetSymbol: AssetsContractController['getAssetSymbol'];
      getCollectibleTokenURI: AssetsContractController['getCollectibleTokenURI'];
    },
    config?: Partial<BaseConfig>,
    state?: Partial<AssetsState>,
  ) {
    super(config, state);
    this.defaultConfig = {
      networkType: MAINNET,
      selectedAddress: '',
      chainId: '',
    };
    this.defaultState = {
      allCollectibleContracts: {},
      allCollectibles: {},
      allTokens: {},
      collectibleContracts: [],
      collectibles: [],
      ignoredCollectibles: [],
      ignoredTokens: [],
      suggestedAssets: [],
      tokens: [],
    };
    this.initialize();
    this.getAssetName = getAssetName;
    this.getAssetSymbol = getAssetSymbol;
    this.getCollectibleTokenURI = getCollectibleTokenURI;
    onPreferencesStateChange(({ selectedAddress }) => {
      const {
        allCollectibleContracts,
        allCollectibles,
        allTokens,
      } = this.state;
      const { chainId } = this.config;
      this.configure({ selectedAddress });
      this.update({
        collectibleContracts:
          allCollectibleContracts[selectedAddress]?.[chainId] || [],
        collectibles: allCollectibles[selectedAddress]?.[chainId] || [],
        tokens: allTokens[selectedAddress]?.[chainId] || [],
      });
    });
    onNetworkStateChange(({ provider }) => {
      const {
        allCollectibleContracts,
        allCollectibles,
        allTokens,
      } = this.state;
      const { selectedAddress } = this.config;
      const { chainId } = provider;
      this.configure({ chainId });
      this.update({
        collectibleContracts:
          allCollectibleContracts[selectedAddress]?.[chainId] || [],
        collectibles: allCollectibles[selectedAddress]?.[chainId] || [],
        tokens: allTokens[selectedAddress]?.[chainId] || [],
      });
    });
  }

  /**
   * Sets an OpenSea API key to retrieve collectible information
   *
   * @param openSeaApiKey - OpenSea API key
   */
  setApiKey(openSeaApiKey: string) {
    this.openSeaApiKey = openSeaApiKey;
  }

  /**
   * Adds a token to the stored token list
   *
   * @param address - Hex address of the token contract
   * @param symbol - Symbol of the token
   * @param decimals - Number of decimals the token uses
   * @param image - Image of the token
   * @returns - Current token list
   */
  async addToken(
    address: string,
    symbol: string,
    decimals: number,
    image?: string,
  ): Promise<Token[]> {
    const releaseLock = await this.mutex.acquire();
    try {
      address = toChecksumHexAddress(address);
      const { allTokens, tokens } = this.state;
      const { chainId, selectedAddress } = this.config;
      const newEntry: Token = { address, symbol, decimals, image };
      const previousEntry = tokens.find((token) => token.address === address);
      if (previousEntry) {
        const previousIndex = tokens.indexOf(previousEntry);
        tokens[previousIndex] = newEntry;
      } else {
        tokens.push(newEntry);
      }
      const addressTokens = allTokens[selectedAddress];
      const newAddressTokens = { ...addressTokens, ...{ [chainId]: tokens } };
      const newAllTokens = {
        ...allTokens,
        ...{ [selectedAddress]: newAddressTokens },
      };
      const newTokens = [...tokens];
      this.update({ allTokens: newAllTokens, tokens: newTokens });
      return newTokens;
    } finally {
      releaseLock();
    }
  }

  /**
   * Adds a batch of tokens to the stored token list
   *
   * @param tokens - Array of Tokens to be added or updated
   * @returns - Current token list
   */
  async addTokens(tokensToAdd: Token[]): Promise<Token[]> {
    const releaseLock = await this.mutex.acquire();
    const { allTokens, tokens } = this.state;
    const { chainId, selectedAddress } = this.config;

    try {
      tokensToAdd.forEach((tokenToAdd) => {
        const { address, symbol, decimals, image } = tokenToAdd;
        const checksumAddress = toChecksumHexAddress(address);

        const newEntry: Token = {
          address: checksumAddress,
          symbol,
          decimals,
          image,
        };
        const previousEntry = tokens.find(
          (token) => token.address === checksumAddress,
        );
        if (previousEntry) {
          const previousIndex = tokens.indexOf(previousEntry);
          tokens[previousIndex] = newEntry;
        } else {
          tokens.push(newEntry);
        }
      });

      const addressTokens = allTokens[selectedAddress];
      const newAddressTokens = { ...addressTokens, ...{ [chainId]: tokens } };
      const newAllTokens = {
        ...allTokens,
        ...{ [selectedAddress]: newAddressTokens },
      };
      const newTokens = [...tokens];
      this.update({ allTokens: newAllTokens, tokens: newTokens });
      return newTokens;
    } finally {
      releaseLock();
    }
  }

  /**
   * Adds a new suggestedAsset to state. Parameters will be validated according to
   * asset type being watched. A `<suggestedAssetMeta.id>:pending` hub event will be emitted once added.
   *
   * @param asset - Asset to be watched. For now only ERC20 tokens are accepted.
   * @param type - Asset type
   * @returns - Object containing a promise resolving to the suggestedAsset address if accepted
   */
  async watchAsset(asset: Token, type: string): Promise<AssetSuggestionResult> {
    const suggestedAssetMeta = {
      asset,
      id: random(),
      status: SuggestedAssetStatus.pending as SuggestedAssetStatus.pending,
      time: Date.now(),
      type,
    };
    try {
      switch (type) {
        case 'ERC20':
          validateTokenToWatch(asset);
          break;
        default:
          throw new Error(`Asset of type ${type} not supported`);
      }
    } catch (error) {
      this.failSuggestedAsset(suggestedAssetMeta, error);
      return Promise.reject(error);
    }

    const result: Promise<string> = new Promise((resolve, reject) => {
      this.hub.once(
        `${suggestedAssetMeta.id}:finished`,
        (meta: SuggestedAssetMeta) => {
          switch (meta.status) {
            case SuggestedAssetStatus.accepted:
              return resolve(meta.asset.address);
            case SuggestedAssetStatus.rejected:
              return reject(new Error('User rejected to watch the asset.'));
            case SuggestedAssetStatus.failed:
              return reject(new Error(meta.error.message));
            /* istanbul ignore next */
            default:
              return reject(new Error(`Unknown status: ${meta.status}`));
          }
        },
      );
    });
    const { suggestedAssets } = this.state;
    suggestedAssets.push(suggestedAssetMeta);
    this.update({ suggestedAssets: [...suggestedAssets] });
    this.hub.emit('pendingSuggestedAsset', suggestedAssetMeta);
    return { result, suggestedAssetMeta };
  }

  /**
   * Accepts to watch an asset and updates it's status and deletes the suggestedAsset from state,
   * adding the asset to corresponding asset state. In this case ERC20 tokens.
   * A `<suggestedAssetMeta.id>:finished` hub event is fired after accepted or failure.
   *
   * @param suggestedAssetID - ID of the suggestedAsset to accept
   * @returns - Promise resolving when this operation completes
   */
  async acceptWatchAsset(suggestedAssetID: string): Promise<void> {
    const { suggestedAssets } = this.state;
    const index = suggestedAssets.findIndex(
      ({ id }) => suggestedAssetID === id,
    );
    const suggestedAssetMeta = suggestedAssets[index];
    try {
      switch (suggestedAssetMeta.type) {
        case 'ERC20':
          const { address, symbol, decimals, image } = suggestedAssetMeta.asset;
          await this.addToken(address, symbol, decimals, image);
          suggestedAssetMeta.status = SuggestedAssetStatus.accepted;
          this.hub.emit(
            `${suggestedAssetMeta.id}:finished`,
            suggestedAssetMeta,
          );
          break;
        default:
          throw new Error(
            `Asset of type ${suggestedAssetMeta.type} not supported`,
          );
      }
    } catch (error) {
      this.failSuggestedAsset(suggestedAssetMeta, error);
    }
    const newSuggestedAssets = suggestedAssets.filter(
      ({ id }) => id !== suggestedAssetID,
    );
    this.update({ suggestedAssets: [...newSuggestedAssets] });
  }

  /**
   * Rejects a watchAsset request based on its ID by setting its status to "rejected"
   * and emitting a `<suggestedAssetMeta.id>:finished` hub event.
   *
   * @param suggestedAssetID - ID of the suggestedAsset to accept
   */
  rejectWatchAsset(suggestedAssetID: string) {
    const { suggestedAssets } = this.state;
    const index = suggestedAssets.findIndex(
      ({ id }) => suggestedAssetID === id,
    );
    const suggestedAssetMeta = suggestedAssets[index];
    if (!suggestedAssetMeta) {
      return;
    }
    suggestedAssetMeta.status = SuggestedAssetStatus.rejected;
    this.hub.emit(`${suggestedAssetMeta.id}:finished`, suggestedAssetMeta);
    const newSuggestedAssets = suggestedAssets.filter(
      ({ id }) => id !== suggestedAssetID,
    );
    this.update({ suggestedAssets: [...newSuggestedAssets] });
  }

  /**
   * Adds a collectible and respective collectible contract to the stored collectible and collectible contracts lists
   *
   * @param address - Hex address of the collectible contract
   * @param tokenId - The collectible identifier
   * @param collectibleMetadata - Collectible optional metadata
   * @param detection? - Whether the collectible is manually added or autodetected
   * @returns - Promise resolving to the current collectible list
   */
  async addCollectible(
    address: string,
    tokenId: number,
    collectibleMetadata?: CollectibleMetadata,
    detection?: boolean,
  ) {
    address = toChecksumHexAddress(address);
    const newCollectibleContracts = await this.addCollectibleContract(
      address,
      detection,
    );

    collectibleMetadata =
      collectibleMetadata ||
      (await this.getCollectibleInformation(address, tokenId));

    // If collectible contract was not added, do not add individual collectible
    const collectibleContract = newCollectibleContracts.find(
      (contract) => contract.address === address,
    );
    // If collectible contract information, add individual collectible
    if (collectibleContract) {
      await this.addIndividualCollectible(
        address,
        tokenId,
        collectibleMetadata,
      );
    }
  }

  /**
   * Removes a token from the stored token list and saves it in ignored tokens list
   *
   * @param address - Hex address of the token contract
   */
  removeAndIgnoreToken(address: string) {
    address = toChecksumHexAddress(address);
    const { allTokens, tokens, ignoredTokens } = this.state;
    const { chainId, selectedAddress } = this.config;
    const newIgnoredTokens = [...ignoredTokens];
    const newTokens = tokens.filter((token) => {
      if (token.address === address) {
        const alreadyIgnored = newIgnoredTokens.find(
          (t) => t.address === address,
        );
        !alreadyIgnored && newIgnoredTokens.push(token);
        return false;
      }
      return true;
    });
    const addressTokens = allTokens[selectedAddress];
    const newAddressTokens = { ...addressTokens, ...{ [chainId]: newTokens } };
    const newAllTokens = {
      ...allTokens,
      ...{ [selectedAddress]: newAddressTokens },
    };
    this.update({
      allTokens: newAllTokens,
      tokens: newTokens,
      ignoredTokens: newIgnoredTokens,
    });
  }

  /**
   * Removes a token from the stored token list
   *
   * @param address - Hex address of the token contract
   */
  removeToken(address: string) {
    address = toChecksumHexAddress(address);
    const { allTokens, tokens } = this.state;
    const { chainId, selectedAddress } = this.config;
    const newTokens = tokens.filter((token) => token.address !== address);
    const addressTokens = allTokens[selectedAddress];
    const newAddressTokens = { ...addressTokens, ...{ [chainId]: newTokens } };
    const newAllTokens = {
      ...allTokens,
      ...{ [selectedAddress]: newAddressTokens },
    };
    this.update({ allTokens: newAllTokens, tokens: newTokens });
  }

  /**
   * Removes a collectible from the stored token list
   *
   * @param address - Hex address of the collectible contract
   * @param tokenId - Token identifier of the collectible
   */
  removeCollectible(address: string, tokenId: number) {
    address = toChecksumHexAddress(address);
    this.removeIndividualCollectible(address, tokenId);
    const { collectibles } = this.state;
    const remainingCollectible = collectibles.find(
      (collectible) => collectible.address === address,
    );
    if (!remainingCollectible) {
      this.removeCollectibleContract(address);
    }
  }

  /**
   * Removes a collectible from the stored token list and saves it in ignored collectibles list
   *
   * @param address - Hex address of the collectible contract
   * @param tokenId - Token identifier of the collectible
   */
  removeAndIgnoreCollectible(address: string, tokenId: number) {
    address = toChecksumHexAddress(address);
    this.removeAndIgnoreIndividualCollectible(address, tokenId);
    const { collectibles } = this.state;
    const remainingCollectible = collectibles.find(
      (collectible) => collectible.address === address,
    );
    if (!remainingCollectible) {
      this.removeCollectibleContract(address);
    }
  }

  /**
   * Removes all tokens from the ignored list
   */
  clearIgnoredTokens() {
    this.update({ ignoredTokens: [] });
  }

  /**
   * Removes all collectibles from the ignored list
   */
  clearIgnoredCollectibles() {
    this.update({ ignoredCollectibles: [] });
  }
}

export default AssetsController;
