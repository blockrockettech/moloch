const Token = artifacts.require('Token');
const Moloch = artifacts.require('Moloch');

module.exports = async function (deployer, network, accounts) {

    const token = await Token.deployed();
    
    await deployer.deploy(Moloch,
        accounts[0], // summoner
        [token.address], // _approvedTokens
        600, // _periodDuration -> 10 mins
        1, // _votingPeriodLength
        1, // _gracePeriodLength
        1, // _emergencyExitWait
        10, // _proposalDeposit
        3, // _dilutionBound
        1, // _processingReward
        {from: accounts[0]}
    );
};
