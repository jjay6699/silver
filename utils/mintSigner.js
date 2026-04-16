const { ethers } = require("ethers");

const DOMAIN_NAME = process.env.MINT_DOMAIN_NAME || "TPC Silver";
const DOMAIN_VERSION = process.env.MINT_DOMAIN_VERSION || "1";

function getDomain(chainId, verifyingContract) {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}

const types = {
  Mint: [
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

async function signMint({
  privateKey,
  chainId,
  contractAddress,
  to,
  amount,
  nonce,
  deadline,
}) {
  if (!privateKey) throw new Error("privateKey required");
  if (!chainId) throw new Error("chainId required");
  if (!contractAddress) throw new Error("contractAddress required");

  const wallet = new ethers.Wallet(privateKey);
  const domain = getDomain(Number(chainId), contractAddress);
  const message = { to, amount, nonce, deadline };
  return wallet.signTypedData(domain, types, message);
}

module.exports = {
  signMint,
  types,
  getDomain,
};
