// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract TPCToken is ERC20, ERC20Capped, ERC20Permit, AccessControl, Pausable, EIP712, ReentrancyGuard {
    using ECDSA for bytes32;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant AUTHORIZER_ROLE = keccak256("AUTHORIZER_ROLE");

    bytes32 private constant MINT_TYPEHASH =
        keccak256("Mint(address to,uint256 amount,uint256 nonce,uint256 deadline)");

    mapping(address => uint256) public nonces;

    uint256 public constant TPC_PER_COIN = 1000;
    uint256 public mintPriceWeiPerCoin;
    address public treasury;
    uint256 public minMintAmount;

    event MintPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event MintedWithEth(address indexed buyer, uint256 amount, uint256 totalCostWei);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event MinMintAmountUpdated(uint256 oldAmount, uint256 newAmount);

    constructor(
        address admin,
        uint256 maxSupply,
        uint256 initialMintPriceWeiPerCoin,
        address initialTreasury
    )
        ERC20("TPC Silver", "TPC")
        ERC20Capped(maxSupply)
        ERC20Permit("TPC Silver")
        EIP712("TPC Silver", "1")
    {
        require(admin != address(0), "admin required");
        require(maxSupply > 0, "maxSupply required");
        require(initialTreasury != address(0), "treasury required");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(AUTHORIZER_ROLE, admin);
        _setMintPrice(initialMintPriceWeiPerCoin);
        treasury = initialTreasury;
        minMintAmount = 1e18;
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function mintWithEth(uint256 amount) external payable whenNotPaused nonReentrant {
        require(amount > 0, "amount required");
        require(amount >= minMintAmount, "amount below minimum");
        uint256 cost = _quoteMintCost(amount);
        require(msg.value >= cost, "insufficient ETH");
        _mint(msg.sender, amount);
        _safeTransferEth(payable(treasury), cost);
        if (msg.value > cost) _safeTransferEth(payable(msg.sender), msg.value - cost);
        emit MintedWithEth(msg.sender, amount, cost);
    }

    function mintWithSig(
        address to,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        require(msg.sender == to, "unauthorized caller");
        require(block.timestamp <= deadline, "signature expired");
        require(nonce == nonces[to], "invalid nonce");

        bytes32 structHash = keccak256(abi.encode(MINT_TYPEHASH, to, amount, nonce, deadline));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        require(hasRole(AUTHORIZER_ROLE, signer), "invalid signer");

        nonces[to] = nonce + 1;
        _mint(to, amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function setMintPrice(uint256 newPriceWeiPerCoin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMintPrice(newPriceWeiPerCoin);
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newTreasury != address(0), "treasury required");
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    function setMinMintAmount(uint256 newAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newAmount > 0, "min amount required");
        uint256 oldAmount = minMintAmount;
        minMintAmount = newAmount;
        emit MinMintAmountUpdated(oldAmount, newAmount);
    }

    function withdrawStuckEth(address payable to) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        require(to != address(0), "to required");
        _safeTransferEth(to, address(this).balance);
    }

    function quoteMintCost(uint256 amount) external view returns (uint256) {
        return _quoteMintCost(amount);
    }

    function _setMintPrice(uint256 newPriceWeiPerCoin) internal {
        uint256 oldPrice = mintPriceWeiPerCoin;
        mintPriceWeiPerCoin = newPriceWeiPerCoin;
        emit MintPriceUpdated(oldPrice, newPriceWeiPerCoin);
    }

    function _quoteMintCost(uint256 amount) internal view returns (uint256) {
        if (mintPriceWeiPerCoin == 0) return 0;
        return (amount * mintPriceWeiPerCoin) / (TPC_PER_COIN * 1e18);
    }

    function _safeTransferEth(address payable to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{ value: amount }("");
        require(ok, "ETH transfer failed");
    }

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Capped)
    {
        require(!paused(), "token transfer while paused");
        super._update(from, to, value);
    }
}
