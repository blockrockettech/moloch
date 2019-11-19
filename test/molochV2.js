// v2 test spec
//
// Process
// 0. Read the Guide
//  - https://github.com/MolochVentures/moloch/blob/master/test/README.md DONE
// 1. Remove obviated code
// 2. Update tests in logical order (constructor, submitProposal, etc..)
//  - update test code based on changelog to get each test passing
// 3. Add tests for new functions
// 4. Add tests for new edge cases
//
// Cleanup
// - remove abort tests
// - update to new proposal mapping data structure
// - update to new proposal.flags data structure
// - update to using a base token instead of default moloch.approvedToken
// - update to deposit token for proposal deposits instead of approvedToken
//
// New Functions
// - sponsorProposal
// - submitWhitelistProposal
// - submitGuildKickProposal
// - safeRagequit
// - cancelProposal
//
// submitProposal
// - update verifySubmitProposal to simply check that proposal is saved
// - test all requires, modifiers, and code paths (whitelist, guild kick)
//
// sponsorProposal
// - copy verifySubmitProposal code to verifySponsorProposal to do the rest
// - test all requires, modifiers, and code paths (whitelist, guild kick)
//
// submitWhitelistProposal
// - check that proposal data are saved properly
//
// submitGuildKickProposal
// - check that proposal data are saved properly
//
// processProposal
// - passing proposal auto-fails if guildbank doesn't have $$ for a payment
//   - proposal sends payment otherwise
// - return funds to proposer, not applicant
// - guild kick ragequits on behalf of a user
//   - updates proposedToKick (for both successs & failure)
// - token whitelist adds token to whitelist
//   - updates proposedToWhitelist (for both successs & failure)
//
// safeRagequit
// - works only for approved tokens, ragequits the correct amounts
//   - e.g. airdrop a non-whitelisted token on to guildbank, then try
//
// cancelProposal
// - returns the tribute tokens to the proposer
//
// New Edge Cases
// - ragequit with multiple tokens in guildbank
// - ragequit too many tokens (loop should run out of gas)
// - ragequit one less than too many tokens
// - safeRagequit even when there are too many tokens to ragequit
//   - might not work with simply 1 less b/c gas cost of providing token array
// - processProposal after emergencyExitWait expires
//   - [setup] -> break a whitelisted token in the guildbank on purpose
//   - proposal after it in queue should be able to be processed immediately
//   - broken tribute tokens must not be returned (check balance)
// - processProposal guildkick auto-fails b/c of token transfer restriction
//   - proposal can still be processed after emergencyExitWait expires

const { artifacts, ethereum, web3 } = require('@nomiclabs/buidler')
const chai = require('chai')
const { assert } = chai

const utils = require('./utils')

const BN = web3.utils.BN

chai
  .use(require('chai-as-promised'))
  .should()

const Moloch = artifacts.require('./Moloch')
const GuildBank = artifacts.require('./GuildBank')
const Token = artifacts.require('./Token')

const deploymentConfig = {
  'SUMMONER': '0x9a8d670c323e894dda9a045372a75d607a47cb9e',
  'PERIOD_DURATION_IN_SECONDS': 17280,
  'VOTING_DURATON_IN_PERIODS': 35,
  'GRACE_DURATON_IN_PERIODS': 35,
  'EMERGENCY_EXIT_WAIT_IN_PERIODS': 35,
  'PROPOSAL_DEPOSIT': 10,
  'DILUTION_BOUND': 3,
  'PROCESSING_REWARD': 1,
  'TOKEN_SUPPLY': 10000
}

const revertMesages = {
  molochConstructorSummonerCannotBe0: 'summoner cannot be 0',
  molochConstructorPeriodDurationCannotBe0: '_periodDuration cannot be 0',
  molochConstructorVotingPeriodLengthCannotBe0: '_votingPeriodLength cannot be 0',
  molochConstructorVotingPeriodLengthExceedsLimit: '_votingPeriodLength exceeds limit',
  molochConstructorGracePeriodLengthExceedsLimit: '_gracePeriodLength exceeds limit',
  molochConstructorEmergencyExitWaitCannotBe0: '_emergencyExitWait cannot be 0',
  molochConstructorDilutionBoundCannotBe0: '_dilutionBound cannot be 0',
  molochConstructorDilutionBoundExceedsLimit: '_dilutionBound exceeds limit',
  molochConstructorNeedAtLeastOneApprovedToken: 'need at least one approved token',
  molochConstructorDepositCannotBeSmallerThanProcessingReward: '_proposalDeposit cannot be smaller than _processingReward',
  molochConstructorApprovedTokenCannotBe0: '_approvedToken cannot be 0',
  molochConstructorDuplicateApprovedToken: 'revert duplicate approved token',
}

const SolRevert = 'VM Exception while processing transaction: revert'

const zeroAddress = '0x0000000000000000000000000000000000000000'
const notOwnedAddress = '0x0000000000000000000000000000000000000002'

const _1 = new BN('1')
const _1e18 = new BN('1000000000000000000') // 1e18
const _1e18Plus1 = _1e18.add(_1)
const _10e18 = new BN('10000000000000000000') // 10e18
const _10e18Plus1 = _10e18.add(_1)

async function blockTime () {
  const block = await web3.eth.getBlock('latest')
  return block.timestamp
}

async function snapshot () {
  return ethereum.send('evm_snapshot', [])
}

async function restore (snapshotId) {
  return ethereum.send('evm_revert', [snapshotId])
}

async function forceMine () {
  return ethereum.send('evm_mine', [])
}

async function moveForwardPeriods (periods) {
  await blockTime()
  const goToTime = deploymentConfig.PERIOD_DURATION_IN_SECONDS * periods
  await ethereum.send('evm_increaseTime', [goToTime])
  await forceMine()
  await blockTime()
  return true
}

let moloch, guildBank, tokenAlpha, tokenBeta
let proposal1, proposal2

const initSummonerBalance = 100

contract('Moloch', ([creator, summoner, applicant1, applicant2, processor, delegateKey, ...otherAccounts]) => {
  let snapshotId

  before('deploy contracts', async () => {
    tokenAlpha = await Token.new(deploymentConfig.TOKEN_SUPPLY)
    tokenBeta = await Token.new(deploymentConfig.TOKEN_SUPPLY)

    moloch = await Moloch.new(
      deploymentConfig.SUMMONER,
      [tokenAlpha.address, tokenBeta.address],
      deploymentConfig.PERIOD_DURATION_IN_SECONDS,
      deploymentConfig.VOTING_DURATON_IN_PERIODS,
      deploymentConfig.GRACE_DURATON_IN_PERIODS,
      deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
      deploymentConfig.PROPOSAL_DEPOSIT,
      deploymentConfig.DILUTION_BOUND,
      deploymentConfig.PROCESSING_REWARD
    )

    const guildBankAddress = await moloch.guildBank()
    guildBank = await GuildBank.at(guildBankAddress)
  })

  beforeEach(async () => {
    snapshotId = await snapshot()

    proposal1 = {
      applicant: applicant1,
      sharesRequested: 1,
      tributeOffered: 100,
      tributeToken: tokenAlpha.address,
      paymentRequested: 0,
      paymentToken: tokenAlpha.address,
      details: 'all hail moloch'
    }

    tokenAlpha.transfer(summoner, initSummonerBalance, { from: creator })
  })

  afterEach(async () => {
    await restore(snapshotId)
  })

  describe('constructor', () => {
    it('verify deployment parameters', async () => {
      // eslint-disable-next-line no-unused-vars
      const now = await blockTime()

      const proposalCount = await moloch.proposalCount()
      assert.equal(proposalCount, 0)

      const depositToken = await moloch.depositToken()
      assert.equal(depositToken, tokenAlpha.address)

      const guildBankAddress = await moloch.guildBank()
      assert.equal(guildBankAddress, guildBank.address)

      const guildBankOwner = await guildBank.owner()
      assert.equal(guildBankOwner, moloch.address)

      const periodDuration = await moloch.periodDuration()
      assert.equal(+periodDuration, deploymentConfig.PERIOD_DURATION_IN_SECONDS)

      const votingPeriodLength = await moloch.votingPeriodLength()
      assert.equal(+votingPeriodLength, deploymentConfig.VOTING_DURATON_IN_PERIODS)

      const gracePeriodLength = await moloch.gracePeriodLength()
      assert.equal(+gracePeriodLength, deploymentConfig.GRACE_DURATON_IN_PERIODS)

      const emergencyExitWaitLength = await moloch.emergencyExitWait()
      assert.equal(+emergencyExitWaitLength, deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS)

      const proposalDeposit = await moloch.proposalDeposit()
      assert.equal(+proposalDeposit, deploymentConfig.PROPOSAL_DEPOSIT)

      const dilutionBound = await moloch.dilutionBound()
      assert.equal(+dilutionBound, deploymentConfig.DILUTION_BOUND)

      const processingReward = await moloch.processingReward()
      assert.equal(+processingReward, deploymentConfig.PROCESSING_REWARD)

      const currentPeriod = await moloch.getCurrentPeriod()
      assert.equal(+currentPeriod, 0)

      const summonerData = await moloch.members(deploymentConfig.SUMMONER)
      assert.equal(summonerData.delegateKey.toLowerCase(), deploymentConfig.SUMMONER) // delegateKey matches
      assert.equal(summonerData.shares, 1)
      assert.equal(summonerData.exists, true)
      assert.equal(summonerData.highestIndexYesVote, 0)

      const summonerAddressByDelegateKey = await moloch.memberAddressByDelegateKey(
        deploymentConfig.SUMMONER
      )
      assert.equal(summonerAddressByDelegateKey.toLowerCase(), deploymentConfig.SUMMONER)

      const totalShares = await moloch.totalShares()
      assert.equal(+totalShares, 1)

      // confirm initial deposit token supply and summoner balance
      const tokenSupply = await tokenAlpha.totalSupply()
      assert.equal(+tokenSupply.toString(), deploymentConfig.TOKEN_SUPPLY)
      const summonerBalance = await tokenAlpha.balanceOf(summoner)
      assert.equal(+summonerBalance.toString(), initSummonerBalance)
      const creatorBalance = await tokenAlpha.balanceOf(creator)
      assert.equal(creatorBalance, deploymentConfig.TOKEN_SUPPLY - initSummonerBalance)

      // check all tokens passed in construction are approved
      const tokenAlphaApproved = await moloch.tokenWhitelist(tokenAlpha.address)
      assert.equal(tokenAlphaApproved, true)

      const tokenBetaApproved = await moloch.tokenWhitelist(tokenBeta.address)
      assert.equal(tokenBetaApproved, true)

      // first token should be the deposit token
      const firstWhitelistedToken = await moloch.approvedTokens(0)
      assert.equal(firstWhitelistedToken, depositToken)
      assert.equal(firstWhitelistedToken, tokenAlpha.address)

      // second token should be the additional token
      const secondWhitelistedToken = await moloch.approvedTokens(1)
      assert.equal(secondWhitelistedToken, tokenBeta.address)
    })

    it('require fail - summoner can not be zero address', async () => {
      await Moloch.new(
        zeroAddress,
        [tokenAlpha.address, tokenBeta.address],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        deploymentConfig.VOTING_DURATON_IN_PERIODS,
        deploymentConfig.GRACE_DURATON_IN_PERIODS,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        deploymentConfig.PROPOSAL_DEPOSIT,
        deploymentConfig.DILUTION_BOUND,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorSummonerCannotBe0)
    })

    it('require fail - period duration can not be zero', async () => {
      await Moloch.new(
        deploymentConfig.SUMMONER,
        [tokenAlpha.address, tokenBeta.address],
        0,
        deploymentConfig.VOTING_DURATON_IN_PERIODS,
        deploymentConfig.GRACE_DURATON_IN_PERIODS,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        deploymentConfig.PROPOSAL_DEPOSIT,
        deploymentConfig.DILUTION_BOUND,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorPeriodDurationCannotBe0)
    })

    it('require fail - voting period can not be zero', async () => {
      await Moloch.new(
        deploymentConfig.SUMMONER,
        [tokenAlpha.address, tokenBeta.address],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        0,
        deploymentConfig.GRACE_DURATON_IN_PERIODS,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        deploymentConfig.PROPOSAL_DEPOSIT,
        deploymentConfig.DILUTION_BOUND,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorVotingPeriodLengthCannotBe0)
    })

    it('require fail - voting period exceeds limit', async () => {
      await Moloch.new(
        deploymentConfig.SUMMONER,
        [tokenAlpha.address, tokenBeta.address],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        _10e18,
        deploymentConfig.GRACE_DURATON_IN_PERIODS,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        deploymentConfig.PROPOSAL_DEPOSIT,
        deploymentConfig.DILUTION_BOUND,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorVotingPeriodLengthExceedsLimit)

      await Moloch.new(
        deploymentConfig.SUMMONER,
        [tokenAlpha.address, tokenBeta.address],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        _10e18Plus1,
        deploymentConfig.GRACE_DURATON_IN_PERIODS,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        deploymentConfig.PROPOSAL_DEPOSIT,
        deploymentConfig.DILUTION_BOUND,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorVotingPeriodLengthExceedsLimit)
    })

    it('require fail - grace period exceeds limit', async () => {
      await Moloch.new(
        deploymentConfig.SUMMONER,
        [tokenAlpha.address, tokenBeta.address],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        deploymentConfig.VOTING_DURATON_IN_PERIODS,
        _10e18,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        deploymentConfig.PROPOSAL_DEPOSIT,
        deploymentConfig.DILUTION_BOUND,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorGracePeriodLengthExceedsLimit)

      await Moloch.new(
        deploymentConfig.SUMMONER,
        [tokenAlpha.address, tokenBeta.address],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        deploymentConfig.VOTING_DURATON_IN_PERIODS,
        _10e18Plus1,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        deploymentConfig.PROPOSAL_DEPOSIT,
        deploymentConfig.DILUTION_BOUND,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorGracePeriodLengthExceedsLimit)
    })

    it('require fail - emergency exit wait can not be zero', async () => {
      await Moloch.new(
        deploymentConfig.SUMMONER,
        [tokenAlpha.address, tokenBeta.address],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        deploymentConfig.VOTING_DURATON_IN_PERIODS,
        deploymentConfig.GRACE_DURATON_IN_PERIODS,
        0,
        deploymentConfig.PROPOSAL_DEPOSIT,
        deploymentConfig.DILUTION_BOUND,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorEmergencyExitWaitCannotBe0)
    })

    it('require fail - dilution bound can not be zero', async () => {
      await Moloch.new(
        deploymentConfig.SUMMONER,
        [tokenAlpha.address, tokenBeta.address],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        deploymentConfig.VOTING_DURATON_IN_PERIODS,
        deploymentConfig.GRACE_DURATON_IN_PERIODS,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        deploymentConfig.PROPOSAL_DEPOSIT,
        0,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorDilutionBoundCannotBe0)
    })

    it('require fail - dilution bound exceeds limit', async () => {
      await Moloch.new(
        deploymentConfig.SUMMONER,
        [tokenAlpha.address, tokenBeta.address],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        deploymentConfig.VOTING_DURATON_IN_PERIODS,
        deploymentConfig.GRACE_DURATON_IN_PERIODS,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        deploymentConfig.PROPOSAL_DEPOSIT,
        _10e18,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorDilutionBoundExceedsLimit)

      await Moloch.new(
        deploymentConfig.SUMMONER,
        [tokenAlpha.address, tokenBeta.address],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        deploymentConfig.VOTING_DURATON_IN_PERIODS,
        deploymentConfig.GRACE_DURATON_IN_PERIODS,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        deploymentConfig.PROPOSAL_DEPOSIT,
        _10e18Plus1,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorDilutionBoundExceedsLimit)
    })

    it('require fail - need at least one approved token', async () => {
      await Moloch.new(
        deploymentConfig.SUMMONER,
        [],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        deploymentConfig.VOTING_DURATON_IN_PERIODS,
        deploymentConfig.GRACE_DURATON_IN_PERIODS,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        deploymentConfig.PROPOSAL_DEPOSIT,
        deploymentConfig.DILUTION_BOUND,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorNeedAtLeastOneApprovedToken)
    })

    it('require fail - deposit cannot be smaller than processing reward', async () => {
      await Moloch.new(
        deploymentConfig.SUMMONER,
        [tokenAlpha.address, tokenBeta.address],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        deploymentConfig.VOTING_DURATON_IN_PERIODS,
        deploymentConfig.GRACE_DURATON_IN_PERIODS,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        _1e18,
        deploymentConfig.DILUTION_BOUND,
        _1e18Plus1
      ).should.be.rejectedWith(revertMesages.molochConstructorDepositCannotBeSmallerThanProcessingReward)
    })

    it('require fail - approved token cannot be zero', async () => {
      await Moloch.new(
        deploymentConfig.SUMMONER,
        [zeroAddress, tokenBeta.address],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        deploymentConfig.VOTING_DURATON_IN_PERIODS,
        deploymentConfig.GRACE_DURATON_IN_PERIODS,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        deploymentConfig.PROPOSAL_DEPOSIT,
        deploymentConfig.DILUTION_BOUND,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorApprovedTokenCannotBe0)
    })

    it('require fail - duplicate approved token', async () => {
      await Moloch.new(
        deploymentConfig.SUMMONER,
        [tokenAlpha.address, tokenAlpha.address],
        deploymentConfig.PERIOD_DURATION_IN_SECONDS,
        deploymentConfig.VOTING_DURATON_IN_PERIODS,
        deploymentConfig.GRACE_DURATON_IN_PERIODS,
        deploymentConfig.EMERGENCY_EXIT_WAIT_IN_PERIODS,
        deploymentConfig.PROPOSAL_DEPOSIT,
        deploymentConfig.DILUTION_BOUND,
        deploymentConfig.PROCESSING_REWARD
      ).should.be.rejectedWith(revertMesages.molochConstructorDuplicateApprovedToken)
    })
  })
})