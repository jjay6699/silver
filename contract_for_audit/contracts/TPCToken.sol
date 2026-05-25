// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title TPC Silver ERC20 token
/// @notice Capped ERC20 token with permit approvals, role-based minting, ETH minting, and authorized signature minting.
/// @dev Transfers, mints, and burns are blocked while the contract is paused.
contract TPCToken is ERC20, ERC20Capped, ERC20Permit, AccessControl, Pausable, ReentrancyGuard {
    using ECDSA for bytes32;

    /// @notice Role allowed to pause and unpause token activity.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Role allowed to mint tokens directly.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    /// @notice Role allowed to sign EIP-712 mint authorizations.
    bytes32 public constant AUTHORIZER_ROLE = keccak256("AUTHORIZER_ROLE");

    bytes32 private constant MINT_TYPEHASH =
        keccak256("Mint(address to,uint256 amount,uint256 nonce,uint256 deadline)");

    /// @notice Replay-protection nonce used for signature-based minting.
    /// @dev This is separate from ERC20Permit.nonces, which is reserved for permit approvals.
    mapping(address => uint256) public mintNonces;

    /// @notice Number of TPC tokens represented by one priced coin unit.
    uint256 public constant TPC_PER_COIN = 1000;
    /// @notice ETH price, in wei, charged per priced coin unit.
    /// @dev A zero value intentionally enables free ETH minting.
    uint256 public mintPriceWeiPerCoin;
    /// @notice Address that receives ETH collected from mintWithEth.
    address public treasury;
    /// @notice Minimum token amount allowed for public and signature minting.
    uint256 public minMintAmount;

    /// @notice Emitted when the ETH mint price is updated.
    /// @param oldPrice Previous wei price per priced coin unit.
    /// @param newPrice New wei price per priced coin unit.
    event MintPriceUpdated(uint256 oldPrice, uint256 newPrice);
    /// @notice Emitted when tokens are minted by a MINTER_ROLE account.
    /// @param to Recipient of the minted tokens.
    /// @param amount Amount of tokens minted.
    /// @param caller Account that executed the mint.
    event Minted(address indexed to, uint256 amount, address caller);
    /// @notice Emitted when tokens are minted in exchange for ETH.
    /// @param buyer Account that minted and received the tokens.
    /// @param amount Amount of tokens minted.
    /// @param totalCostWei ETH cost forwarded to the treasury, in wei.
    event MintedWithEth(address indexed buyer, uint256 amount, uint256 totalCostWei);
    /// @notice Emitted when tokens are minted using an authorized EIP-712 signature.
    /// @param to Recipient of the minted tokens.
    /// @param amount Amount of tokens minted.
    /// @param signer AUTHORIZER_ROLE account that signed the mint authorization.
    /// @param nonce Mint nonce consumed by the authorization.
    event MintedWithSig(address indexed to, uint256 amount, address indexed signer, uint256 nonce);
    /// @notice Emitted when the treasury address is updated.
    /// @param oldTreasury Previous treasury address.
    /// @param newTreasury New treasury address.
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    /// @notice Emitted when the minimum mint amount is updated.
    /// @param oldAmount Previous minimum mint amount.
    /// @param newAmount New minimum mint amount.
    event MinMintAmountUpdated(uint256 oldAmount, uint256 newAmount);
    /// @notice Emitted when ETH held by the contract is withdrawn by an admin.
    /// @param to Recipient of the withdrawn ETH.
    /// @param amount Amount of ETH withdrawn, in wei.
    event StuckEthWithdrawn(address indexed to, uint256 amount);

    /// @notice Deploys the token and assigns initial administrative roles.
    /// @param admin Address receiving DEFAULT_ADMIN_ROLE, MINTER_ROLE, PAUSER_ROLE, and AUTHORIZER_ROLE.
    /// @param maxSupply Maximum total token supply, using 18 token decimals.
    /// @param initialMintPriceWeiPerCoin Initial ETH mint price per priced coin unit, or zero for free minting.
    /// @param initialTreasury Address receiving ETH collected from mintWithEth.
    constructor(
        address admin,
        uint256 maxSupply,
        uint256 initialMintPriceWeiPerCoin,
        address initialTreasury
    )
        ERC20("TPC Silver", "TPC")
        ERC20Capped(maxSupply)
        ERC20Permit("TPC Silver")
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

    /// @notice Mints tokens directly to an address.
    /// @param to Recipient of the minted tokens.
    /// @param amount Amount of tokens to mint, using 18 token decimals.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
        emit Minted(to, amount, msg.sender);
    }

    /// @notice Mints tokens by paying ETH at the current configured mint price.
    /// @param amount Amount of tokens to mint, using 18 token decimals.
    /// @param maxCost Maximum ETH cost, in wei, the caller is willing to pay.
    /// @dev Reverts if the live quote exceeds maxCost. Any msg.value above the live quote is refunded.
    function mintWithEth(uint256 amount, uint256 maxCost) external payable whenNotPaused nonReentrant {
        require(amount > 0, "amount required");
        require(amount >= minMintAmount, "amount below minimum");
        uint256 cost = _quoteMintCost(amount);
        require(mintPriceWeiPerCoin == 0 || cost > 0, "cost rounds to zero");
        require(cost <= maxCost, "slippage: cost exceeds maxCost");
        require(msg.value >= cost, "insufficient ETH");
        _mint(msg.sender, amount);
        _safeTransferEth(payable(treasury), cost);
        if (msg.value > cost) _safeTransferEth(payable(msg.sender), msg.value - cost);
        emit MintedWithEth(msg.sender, amount, cost);
    }

    /// @notice Mints tokens using an EIP-712 authorization from an AUTHORIZER_ROLE signer.
    /// @param to Recipient of the minted tokens; must be the transaction sender.
    /// @param amount Amount of tokens to mint, using 18 token decimals.
    /// @param nonce Current mint nonce for the recipient.
    /// @param deadline Last timestamp at which the signature is valid.
    /// @param signature EIP-712 signature over the mint authorization.
    function mintWithSig(
        address to,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        require(msg.sender == to, "unauthorized caller");
        require(amount > 0, "amount required");
        require(amount >= minMintAmount, "amount below minimum");
        require(block.timestamp <= deadline, "signature expired");
        require(nonce == mintNonces[to], "invalid nonce");

        bytes32 structHash = keccak256(abi.encode(MINT_TYPEHASH, to, amount, nonce, deadline));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        require(hasRole(AUTHORIZER_ROLE, signer), "invalid signer");

        mintNonces[to] = nonce + 1;
        _mint(to, amount);
        emit MintedWithSig(to, amount, signer, nonce);
    }

    /// @notice Pauses token transfers and minting paths guarded by whenNotPaused.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpauses token transfers and minting paths guarded by whenNotPaused.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Updates the ETH mint price.
    /// @param newPriceWeiPerCoin New ETH price per priced coin unit, in wei, or zero for free minting.
    function setMintPrice(uint256 newPriceWeiPerCoin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMintPrice(newPriceWeiPerCoin);
    }

    /// @notice Updates the treasury that receives ETH from mintWithEth.
    /// @param newTreasury New non-zero treasury address.
    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newTreasury != address(0), "treasury required");
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /// @notice Updates the minimum amount allowed for public and signature minting.
    /// @param newAmount New non-zero minimum mint amount, using 18 token decimals.
    function setMinMintAmount(uint256 newAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newAmount > 0, "min amount required");
        uint256 oldAmount = minMintAmount;
        minMintAmount = newAmount;
        emit MinMintAmountUpdated(oldAmount, newAmount);
    }

    /// @notice Withdraws ETH held by the contract to a recipient.
    /// @param to Recipient of the withdrawn ETH.
    /// @dev Intended for rescuing ETH left in the contract outside normal mint forwarding.
    function withdrawStuckEth(address payable to) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        require(to != address(0), "to required");
        uint256 balance = address(this).balance;
        require(balance > 0, "no stuck ETH");
        _safeTransferEth(to, balance);
        emit StuckEthWithdrawn(to, balance);
    }

    /// @notice Returns the ETH cost for minting a given token amount at the current price.
    /// @param amount Amount of tokens to quote, using 18 token decimals.
    /// @return cost ETH cost in wei.
    function quoteMintCost(uint256 amount) external view returns (uint256) {
        return _quoteMintCost(amount);
    }

    function _setMintPrice(uint256 newPriceWeiPerCoin) internal {
        require(newPriceWeiPerCoin == 0 || newPriceWeiPerCoin >= TPC_PER_COIN, "price below minimum");
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
