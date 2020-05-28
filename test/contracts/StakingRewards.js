const { contract } = require('@nomiclabs/buidler');
const { toBN } = require('web3-utils');

const { toBytes32 } = require('../..');
const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');
const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');
const { mockToken, setupAllContracts, setupContract } = require('./setup');
const { currentTime, toUnit, fastForward } = require('../utils')();

contract('StakingRewards', async accounts => {
	const [
		,
		owner,
		oracle,
		authority,
		rewardEscrowAddress,
		stakingAccount1,
		mockRewardsDistributionAddress,
	] = accounts;

	// Synthetix is the rewardsToken
	// lpToken is the stakingToken
	let synthetix, lpToken, exchangeRates, stakingRewards, rewardsDistribution, feePool;

	const DAY = 86400;
	const ZERO_BN = toBN(0);

	addSnapshotBeforeRestoreAfterEach();

	before(async () => {
		({ token: lpToken } = await mockToken({ accounts, name: 'LPToken', symbol: 'LPT' }));

		({
			RewardsDistribution: rewardsDistribution,
			FeePool: feePool,
			Synthetix: synthetix,
			ExchangeRates: exchangeRates,
		} = await setupAllContracts({
			accounts,
			contracts: ['RewardsDistribution', 'Synthetix', 'FeePool'],
		}));

		stakingRewards = await setupContract({
			accounts,
			contract: 'StakingRewards',
			args: [owner, synthetix.address, lpToken.address],
		});

		await Promise.all([
			rewardsDistribution.setAuthority(authority, { from: owner }),
			rewardsDistribution.setRewardEscrow(rewardEscrowAddress, { from: owner }),
			rewardsDistribution.setSynthetixProxy(synthetix.address, { from: owner }),
			rewardsDistribution.setFeePoolProxy(feePool.address, { from: owner }),
		]);
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: stakingRewards.abi,
			ignoreParents: ['ReentrancyGuard', 'Owned'],
			expected: [
				'stake',
				'withdraw',
				'exit',
				'getReward',
				'notifyRewardAmount',
				'setRewardsDistribution',
			],
		});
	});

	describe('Constructor & Settings', async () => {
		it('should set snx on constructor', async () => {
			const synthetixAddress = await stakingRewards.rewardsToken();
			assert.equal(synthetixAddress, synthetix.address);
		});

		it('should set lp token on constructor', async () => {
			const tokenAddress = await stakingRewards.stakingToken();
			assert.equal(tokenAddress, lpToken.address);
		});

		it('should set owner on constructor', async () => {
			const ownerAddress = await stakingRewards.owner();
			assert.equal(ownerAddress, owner);
		});
	});

	describe('Function permissions', async () => {
		before(async () => {
			await stakingRewards.setRewardsDistribution(mockRewardsDistributionAddress, {
				from: owner,
			});
		});

		it('only owner can call setRewardsDistribution', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: stakingRewards.setRewardsDistribution,
				args: [rewardsDistribution.address],
				address: owner,
				accounts,
			});
		});

		it('only rewardsDistribution address can call notifyRewardAmount', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: stakingRewards.notifyRewardAmount,
				args: [toUnit(1.0)],
				address: mockRewardsDistributionAddress,
				accounts,
			});
		});
	});

	describe('lastTimeRewardApplicable()', async () => {
		before(async () => {
			await stakingRewards.setRewardsDistribution(mockRewardsDistributionAddress, {
				from: owner,
			});
		});

		it('should return 0', async () => {
			assert.bnEqual(await stakingRewards.lastTimeRewardApplicable(), ZERO_BN);
		});

		describe('when updated', async () => {
			it('should equal current timestamp', async () => {
				await stakingRewards.notifyRewardAmount(toUnit(1.0), {
					from: mockRewardsDistributionAddress,
				});

				const cur = await currentTime();
				const lastTimeReward = await stakingRewards.lastTimeRewardApplicable();

				assert.equal(cur.toString(), lastTimeReward.toString());
			});
		});
	});

	describe('rewardPerToken()', async () => {
		before(async () => {
			await stakingRewards.setRewardsDistribution(mockRewardsDistributionAddress, {
				from: owner,
			});
		});

		it('should return 0', async () => {
			assert.bnEqual(await stakingRewards.rewardPerToken(), ZERO_BN);
		});

		it('should be > 0', async () => {
			const totalToStake = toUnit('100');
			await lpToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await lpToken.approve(stakingRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingRewards.stake(totalToStake, { from: stakingAccount1 });

			const totalSupply = await stakingRewards.totalSupply();
			assert.equal(totalSupply.gt(ZERO_BN), true);

			await stakingRewards.notifyRewardAmount(toUnit(5000.0), {
				from: mockRewardsDistributionAddress,
			});

			fastForward(DAY);

			const rewardPerToken = await stakingRewards.rewardPerToken();
			assert.equal(rewardPerToken.gt(ZERO_BN), true);
		});
	});

	describe('stake()', async () => {
		before(async () => {
			await stakingRewards.setRewardsDistribution(mockRewardsDistributionAddress, {
				from: owner,
			});
		});

		it('staking increases staking balance and decreases lp balance', async () => {
			const totalToStake = toUnit('100');
			await lpToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await lpToken.approve(stakingRewards.address, totalToStake, { from: stakingAccount1 });

			const initialStakeBal = await stakingRewards.balanceOf(stakingAccount1);
			const initialLpBal = await lpToken.balanceOf(stakingAccount1);

			await stakingRewards.stake(totalToStake, { from: stakingAccount1 });

			const postStakeBal = await stakingRewards.balanceOf(stakingAccount1);
			const postLpBal = await lpToken.balanceOf(stakingAccount1);

			assert.equal(postLpBal.lt(initialLpBal), true);
			assert.equal(postStakeBal.gt(initialStakeBal), true);
		});
	});

	describe('earn()', async () => {
		before(async () => {
			await stakingRewards.setRewardsDistribution(mockRewardsDistributionAddress, {
				from: owner,
			});
		});

		it('should be 0 when not staking', async () => {
			assert.bnEqual(await stakingRewards.earned(stakingAccount1), ZERO_BN);
		});

		it('should be > 0 when staking', async () => {
			const totalToStake = toUnit('100');
			await lpToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await lpToken.approve(stakingRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingRewards.stake(totalToStake, { from: stakingAccount1 });

			await stakingRewards.notifyRewardAmount(toUnit(5000.0), {
				from: mockRewardsDistributionAddress,
			});

			fastForward(DAY);

			const earned = await stakingRewards.earned(stakingAccount1);

			assert.equal(earned.gt(ZERO_BN), true);
		});
	});

	describe('getReward()', async () => {
		before(async () => {
			await stakingRewards.setRewardsDistribution(mockRewardsDistributionAddress, {
				from: owner,
			});

			// Set SNX exchange rate so we can call getReward
			await exchangeRates.setOracle(oracle, { from: owner });
			await exchangeRates.setRateStalePeriod(DAY * 7, { from: owner });
			const updatedTime = await currentTime();
			await exchangeRates.updateRates([toBytes32('SNX')], [toUnit('2')], updatedTime, {
				from: oracle,
			});
			assert.equal(await exchangeRates.rateIsStale(toBytes32('SNX')), false);
		});

		it('should increase synthetix balance and decrease rewards', async () => {
			const totalToStake = toUnit('100');
			const totalToDistribute = toUnit('5000');

			await lpToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await lpToken.approve(stakingRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingRewards.stake(totalToStake, { from: stakingAccount1 });

			await synthetix.transfer(stakingRewards.address, totalToDistribute, { from: owner });
			await stakingRewards.notifyRewardAmount(toUnit(5000.0), {
				from: mockRewardsDistributionAddress,
			});

			fastForward(DAY);

			const initialSnxBal = await synthetix.balanceOf(stakingAccount1);
			const initialEarnedBal = await stakingRewards.earned(stakingAccount1);
			await stakingRewards.getReward({ from: stakingAccount1 });
			const postSnxBal = await synthetix.balanceOf(stakingAccount1);
			const postEarnedBal = await stakingRewards.earned(stakingAccount1);

			assert.equal(postEarnedBal.lt(initialEarnedBal), true);
			assert.equal(postSnxBal.gt(initialSnxBal), true);
		});
	});

	describe('withdraw()', async () => {
		before(async () => {
			await stakingRewards.setRewardsDistribution(mockRewardsDistributionAddress, {
				from: owner,
			});
		});

		it('cannot withdraw if nothing staked', async () => {
			await assert.revert(stakingRewards.withdraw(toUnit('100')), 'SafeMath: subtraction overflow');
		});

		it('should increases lp token balance and decreases staking balance', async () => {
			const totalToStake = toUnit('100');
			await lpToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await lpToken.approve(stakingRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingRewards.stake(totalToStake, { from: stakingAccount1 });

			const initialLpTokenBal = await lpToken.balanceOf(stakingAccount1);
			const initialStakeBal = await stakingRewards.balanceOf(stakingAccount1);

			await stakingRewards.withdraw(totalToStake, { from: stakingAccount1 });

			const postLpTokenBal = await lpToken.balanceOf(stakingAccount1);
			const postStakeBal = await stakingRewards.balanceOf(stakingAccount1);

			assert.bnEqual(postStakeBal.add(toBN(totalToStake)), initialStakeBal);
			assert.bnEqual(initialLpTokenBal.add(toBN(totalToStake)), postLpTokenBal);
		});
	});

	describe('exit()', async () => {
		before(async () => {
			await stakingRewards.setRewardsDistribution(mockRewardsDistributionAddress, {
				from: owner,
			});

			// Set SNX exchange rate so we can call getReward
			await exchangeRates.setOracle(oracle, { from: owner });
			await exchangeRates.setRateStalePeriod(DAY * 7, { from: owner });
			const updatedTime = await currentTime();
			await exchangeRates.updateRates([toBytes32('SNX')], [toUnit('2')], updatedTime, {
				from: oracle,
			});
			assert.equal(await exchangeRates.rateIsStale(toBytes32('SNX')), false);
		});

		it('should retrieve all earned and increase snx bal', async () => {
			const totalToStake = toUnit('100');
			const totalToDistribute = toUnit('5000');

			await lpToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await lpToken.approve(stakingRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingRewards.stake(totalToStake, { from: stakingAccount1 });

			await synthetix.transfer(stakingRewards.address, totalToDistribute, { from: owner });
			await stakingRewards.notifyRewardAmount(toUnit(5000.0), {
				from: mockRewardsDistributionAddress,
			});

			fastForward(DAY);

			const initialSnxBal = await synthetix.balanceOf(stakingAccount1);
			const initialEarnedBal = await stakingRewards.earned(stakingAccount1);
			await stakingRewards.exit({ from: stakingAccount1 });
			const postSnxBal = await synthetix.balanceOf(stakingAccount1);
			const postEarnedBal = await stakingRewards.earned(stakingAccount1);

			assert.equal(postEarnedBal.lt(initialEarnedBal), true);
			assert.equal(postSnxBal.gt(initialSnxBal), true);
			assert.equal(postEarnedBal.eq(ZERO_BN), true);
		});
	});

	describe('Integration Tests', async () => {
		before(async () => {
			// Set exchange rates for synthetix
			// 7 Days here cause we're gonna fast forward 6 days
			await exchangeRates.setOracle(oracle, { from: owner });
			await exchangeRates.setRateStalePeriod(DAY * 7, { from: owner });
			const updatedTime = await currentTime();
			await exchangeRates.updateRates([toBytes32('SNX')], [toUnit('2')], updatedTime, {
				from: oracle,
			});
			assert.equal(await exchangeRates.rateIsStale(toBytes32('SNX')), false);

			// Set rewardDistribution address
			await stakingRewards.setRewardsDistribution(rewardsDistribution.address, {
				from: owner,
			});
			assert.equal(await stakingRewards.rewardsDistribution(), rewardsDistribution.address);
		});

		it('stake and claim', async () => {
			// Transfer some LP Tokens to user
			const totalToStake = toUnit('500');
			await lpToken.transfer(stakingAccount1, totalToStake, { from: owner });

			// Stake LP Tokens
			await lpToken.approve(stakingRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingRewards.stake(totalToStake, { from: stakingAccount1 });

			// Distribute some rewards
			const totalToDistribute = toUnit('35000');
			assert.equal(await rewardsDistribution.distributionsLength(), 0);
			await rewardsDistribution.addRewardDistribution(stakingRewards.address, totalToDistribute, {
				from: owner,
			});
			assert.equal(await rewardsDistribution.distributionsLength(), 1);

			// Transfer SNX to the RewardsDistribution contract address
			await synthetix.transfer(rewardsDistribution.address, totalToDistribute, { from: owner });

			// Distribute Rewards called from Synthetix contract as the authority to distribute
			await rewardsDistribution.distributeRewards(totalToDistribute, {
				from: authority,
			});

			// Period finish should be ~7 days from now
			const periodFinish = await stakingRewards.periodFinish();
			const curTimestamp = await currentTime();
			assert.equal(parseInt(periodFinish.toString(), 10), curTimestamp + DAY * 7);

			// Reward duration is 7 days, so we'll
			// Fastforward time by 6 days to prevent expiration
			fastForward(DAY * 6);

			// Reward rate and reward per token
			const rewardRate = await stakingRewards.rewardRate();
			assert.equal(rewardRate.gt(ZERO_BN), true);

			const rewardPerToken = await stakingRewards.rewardPerToken();
			assert.equal(rewardPerToken.gt(ZERO_BN), true);

			// Make sure we earned in proportion to reward per token
			const snxRewardsEarned = await stakingRewards.earned(stakingAccount1);
			assert.bnEqual(snxRewardsEarned, rewardPerToken.mul(totalToStake).div(toUnit(1)));

			// Make sure after withdrawing, we still have the ~amount of snxRewards
			// The two values will be a bit different as time has "passed"
			const initialWithdraw = toUnit('100');
			await stakingRewards.withdraw(initialWithdraw, { from: stakingAccount1 });
			assert.bnEqual(initialWithdraw, await lpToken.balanceOf(stakingAccount1));

			const snxRewardsEarnedPostWithdraw = await stakingRewards.earned(stakingAccount1);
			assert.bnClose(snxRewardsEarned, snxRewardsEarnedPostWithdraw, toUnit('0.1'));

			// Get rewards
			const initialSnxBal = await synthetix.balanceOf(stakingAccount1);
			await stakingRewards.getReward({ from: stakingAccount1 });
			const postRewardSnxBal = await synthetix.balanceOf(stakingAccount1);

			assert.equal(postRewardSnxBal.gt(initialSnxBal), true);

			// Exit
			const preExitLPBal = await lpToken.balanceOf(stakingAccount1);
			await stakingRewards.exit({ from: stakingAccount1 });
			const postExitLPBal = await lpToken.balanceOf(stakingAccount1);
			assert.equal(postExitLPBal.gt(preExitLPBal), true);
		});
	});
});