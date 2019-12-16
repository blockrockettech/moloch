const Token = artifacts.require('Token');

module.exports = function (deployer, network, accounts) {
    // 10000
    deployer.deploy(Token, '10000000000000000000000', {from: accounts[0]});
};
