import {
	User,
	DriftClient,
	UserAccount,
	OrderRecord,
	WrappedEvent,
	DepositRecord,
	FundingPaymentRecord,
	LiquidationRecord,
	OrderActionRecord,
	SettlePnlRecord,
	NewUserRecord,
	LPRecord,
	StateAccount,
	DLOB,
	BasicUserAccountSubscriber,
	BN,
} from '..';

import {
	Commitment,
	Connection,
	PublicKey,
	RpcResponseAndContext,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import { getNonIdleUserFilter, getUserFilter } from '../memcmp';
import {
	UserAccountFilterCriteria as UserFilterCriteria,
	UserMapConfig,
} from './userMapConfig';
import { WebsocketSubscription } from './WebsocketSubscription';
import { PollingSubscription } from './PollingSubscription';

export interface UserMapInterface {
	subscribe(): Promise<void>;
	unsubscribe(): Promise<void>;
	addPubkey(userAccountPublicKey: PublicKey): Promise<void>;
	has(key: string): boolean;
	get(key: string): User | undefined;
	mustGet(key: string): Promise<User>;
	getUserAuthority(key: string): PublicKey | undefined;
	updateWithOrderRecord(record: OrderRecord): Promise<void>;
	values(): IterableIterator<User>;
}

export class UserMap implements UserMapInterface {
	private userMap = new Map<string, User>();
	driftClient: DriftClient;
	private connection: Connection;
	private commitment: Commitment;
	private includeIdle: boolean;
	private lastNumberOfSubAccounts: BN;
	private subscription: PollingSubscription | WebsocketSubscription;
	private stateAccountUpdateCallback = async (state: StateAccount) => {
		if (!state.numberOfSubAccounts.eq(this.lastNumberOfSubAccounts)) {
			await this.sync();
			this.lastNumberOfSubAccounts = state.numberOfSubAccounts;
		}
	};

	private syncPromise?: Promise<void>;
	private syncPromiseResolver: () => void;

	/**
	 * Constructs a new UserMap instance.
	 */
	constructor(config: UserMapConfig) {
		this.driftClient = config.driftClient;
		if (config.connection) {
			this.connection = config.connection;
		} else {
			this.connection = this.driftClient.connection;
		}
		this.commitment =
			config.subscriptionConfig.commitment ?? this.driftClient.opts.commitment;
		this.includeIdle = config.includeIdle ?? false;
		if (config.subscriptionConfig.type === 'polling') {
			this.subscription = new PollingSubscription({
				userMap: this,
				frequency: config.subscriptionConfig.frequency,
				skipInitialLoad: config.skipInitialLoad,
			});
		} else {
			this.subscription = new WebsocketSubscription({
				userMap: this,
				commitment: this.commitment,
				resubTimeoutMs: config.subscriptionConfig.resubTimeoutMs,
				skipInitialLoad: config.skipInitialLoad,
			});
		}
	}

	public async subscribe() {
		if (this.size() > 0) {
			return;
		}

		await this.driftClient.subscribe();
		this.lastNumberOfSubAccounts =
			this.driftClient.getStateAccount().numberOfSubAccounts;
		this.driftClient.eventEmitter.on(
			'stateAccountUpdate',
			this.stateAccountUpdateCallback
		);

		await this.subscription.subscribe();
	}

	public async addPubkey(
		userAccountPublicKey: PublicKey,
		userAccount?: UserAccount,
		slot?: number
	) {
		const user = new User({
			driftClient: this.driftClient,
			userAccountPublicKey,
			accountSubscription: {
				type: 'custom',
				userAccountSubscriber: new BasicUserAccountSubscriber(
					userAccountPublicKey,
					userAccount,
					slot
				),
			},
		});
		await user.subscribe(userAccount);
		this.userMap.set(userAccountPublicKey.toString(), user);
	}

	public has(key: string): boolean {
		return this.userMap.has(key);
	}

	/**
	 * gets the User for a particular userAccountPublicKey, if no User exists, undefined is returned
	 * @param key userAccountPublicKey to get User for
	 * @returns user User | undefined
	 */
	public get(key: string): User | undefined {
		return this.userMap.get(key);
	}

	/**
	 * gets the User for a particular userAccountPublicKey, if no User exists, new one is created
	 * @param key userAccountPublicKey to get User for
	 * @returns  User
	 */
	public async mustGet(key: string): Promise<User> {
		if (!this.has(key)) {
			await this.addPubkey(new PublicKey(key));
		}
		const user = this.userMap.get(key);
		return user;
	}

	/**
	 * gets the Authority for a particular userAccountPublicKey, if no User exists, undefined is returned
	 * @param key userAccountPublicKey to get User for
	 * @returns authority PublicKey | undefined
	 */
	public getUserAuthority(key: string): PublicKey | undefined {
		const chUser = this.userMap.get(key);
		if (!chUser) {
			return undefined;
		}
		return chUser.getUserAccount().authority;
	}

	/**
	 * implements the {@link DLOBSource} interface
	 * create a DLOB from all the subscribed users
	 * @param slot
	 */
	public async getDLOB(slot: number): Promise<DLOB> {
		const dlob = new DLOB();
		await dlob.initFromUserMap(this, slot);
		return dlob;
	}

	public async updateWithOrderRecord(record: OrderRecord) {
		if (!this.has(record.user.toString())) {
			await this.addPubkey(record.user);
		}
	}

	public async updateWithEventRecord(record: WrappedEvent<any>) {
		if (record.eventType === 'DepositRecord') {
			const depositRecord = record as DepositRecord;
			await this.mustGet(depositRecord.user.toString());
		} else if (record.eventType === 'FundingPaymentRecord') {
			const fundingPaymentRecord = record as FundingPaymentRecord;
			await this.mustGet(fundingPaymentRecord.user.toString());
		} else if (record.eventType === 'LiquidationRecord') {
			const liqRecord = record as LiquidationRecord;

			await this.mustGet(liqRecord.user.toString());
			await this.mustGet(liqRecord.liquidator.toString());
		} else if (record.eventType === 'OrderRecord') {
			const orderRecord = record as OrderRecord;
			await this.updateWithOrderRecord(orderRecord);
		} else if (record.eventType === 'OrderActionRecord') {
			const actionRecord = record as OrderActionRecord;

			if (actionRecord.taker) {
				await this.mustGet(actionRecord.taker.toString());
			}
			if (actionRecord.maker) {
				await this.mustGet(actionRecord.maker.toString());
			}
		} else if (record.eventType === 'SettlePnlRecord') {
			const settlePnlRecord = record as SettlePnlRecord;
			await this.mustGet(settlePnlRecord.user.toString());
		} else if (record.eventType === 'NewUserRecord') {
			const newUserRecord = record as NewUserRecord;
			await this.mustGet(newUserRecord.user.toString());
		} else if (record.eventType === 'LPRecord') {
			const lpRecord = record as LPRecord;
			await this.mustGet(lpRecord.user.toString());
		}
	}

	public values(): IterableIterator<User> {
		return this.userMap.values();
	}

	public size(): number {
		return this.userMap.size;
	}

	/**
	 * Returns a unique list of authorities for all users in the UserMap that meet the filter criteria
	 * @param filterCriteria: Users must meet these criteria to be included
	 * @returns
	 */
	public getUniqueAuthorities(
		filterCriteria?: UserFilterCriteria
	): PublicKey[] {
		const usersMeetingCriteria = Array.from(this.userMap.values()).filter(
			(user) => {
				let pass = true;
				if (filterCriteria && filterCriteria.hasOpenOrders) {
					pass = pass && user.getUserAccount().hasOpenOrder;
				}
				return pass;
			}
		);
		const userAuths = new Set(
			usersMeetingCriteria.map((user) =>
				user.getUserAccount().authority.toBase58()
			)
		);
		const userAuthKeys = Array.from(userAuths).map(
			(userAuth) => new PublicKey(userAuth)
		);
		return userAuthKeys;
	}

	public async sync() {
		if (this.syncPromise) {
			return this.syncPromise;
		}
		this.syncPromise = new Promise((resolver) => {
			this.syncPromiseResolver = resolver;
		});

		try {
			const filters = [getUserFilter()];
			if (!this.includeIdle) {
				filters.push(getNonIdleUserFilter());
			}

			const rpcRequestArgs = [
				this.driftClient.program.programId.toBase58(),
				{
					commitment: this.commitment,
					filters,
					encoding: 'base64',
					withContext: true,
				},
			];

			const rpcJSONResponse: any =
				// @ts-ignore
				await this.connection._rpcRequest('getProgramAccounts', rpcRequestArgs);

			const rpcResponseAndContext: RpcResponseAndContext<
				Array<{
					pubkey: PublicKey;
					account: {
						data: [string, string];
					};
				}>
			> = rpcJSONResponse.result;

			const slot = rpcResponseAndContext.context.slot;

			const programAccountBufferMap = new Map<string, Buffer>();
			for (const programAccount of rpcResponseAndContext.value) {
				programAccountBufferMap.set(
					programAccount.pubkey.toString(),
					// @ts-ignore
					Buffer.from(
						programAccount.account.data[0],
						programAccount.account.data[1]
					)
				);
			}

			for (const [key, buffer] of programAccountBufferMap.entries()) {
				if (!this.has(key)) {
					const userAccount =
						this.driftClient.program.account.user.coder.accounts.decodeUnchecked(
							'User',
							buffer
						);
					await this.addPubkey(new PublicKey(key), userAccount);
				}
				// give event loop a chance to breathe
				await new Promise((resolve) => setTimeout(resolve, 0));
			}

			for (const [key, user] of this.userMap.entries()) {
				if (!programAccountBufferMap.has(key)) {
					await user.unsubscribe();
					this.userMap.delete(key);
				} else {
					const userAccount =
						this.driftClient.program.account.user.coder.accounts.decodeUnchecked(
							'User',
							programAccountBufferMap.get(key)
						);
					user.accountSubscriber.updateData(userAccount, slot);
				}
				// give event loop a chance to breathe
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		} catch (e) {
			console.error(`Error in UserMap.sync():`);
			console.error(e);
		} finally {
			this.syncPromiseResolver();
			this.syncPromise = undefined;
		}
	}

	public async unsubscribe() {
		await this.subscription.unsubscribe();

		for (const [key, user] of this.userMap.entries()) {
			await user.unsubscribe();
			this.userMap.delete(key);
		}

		if (this.lastNumberOfSubAccounts) {
			this.driftClient.eventEmitter.removeListener(
				'stateAccountUpdate',
				this.stateAccountUpdateCallback
			);
			this.lastNumberOfSubAccounts = undefined;
		}
	}

	public async updateUserAccount(
		key: string,
		userAccount: UserAccount,
		slot: number
	) {
		if (!this.userMap.has(key)) {
			this.addPubkey(new PublicKey(key), userAccount, slot);
		} else {
			const user = this.userMap.get(key);
			user.accountSubscriber.updateData(userAccount, slot);
		}
	}
}
