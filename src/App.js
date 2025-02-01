import React, { useEffect, useState, useRef } from "react";
import Web3 from "web3";
import "bootstrap/dist/css/bootstrap.min.css";
import CrowdfundingABI from "./CrowdfundingABI.json";

const CONTRACT_ADDRESS = "0x515c0A44D5Ee4db699338B8b7680B235DE9425f5";

const SECONDARY_OWNER = "0x153dfef4355E823dCB0FCc76Efe942BefCa86477";

/* global BigInt */

function App() {
  const [web3, setWeb3] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [contract, setContract] = useState(null);

  // Basic info
  const [currentUser, setCurrentUser] = useState("");
  const [ownerAddress, setOwnerAddress] = useState("");
  const [userBalance, setUserBalance] = useState("0");
  const [collectedFees, setCollectedFees] = useState("0");

  // Form fields for creating campaigns
  const [campaignTitle, setCampaignTitle] = useState("");
  const [campaignPledgeCost, setCampaignPledgeCost] = useState("");
  const [campaignPledgesNeeded, setCampaignPledgesNeeded] = useState("");

  // Lists of campaigns
  const [activeCampaigns, setActiveCampaigns] = useState([]);
  const [fulfilledCampaigns, setFulfilledCampaigns] = useState([]);
  const [cancelledCampaigns, setCancelledCampaigns] = useState([]);

  // Refund status
  const [hasPendingRefunds, setHasPendingRefunds] = useState(false);

  // Owner control panel
  const [newOwner, setNewOwner] = useState("");
  const [banAddress, setBanAddress] = useState("");

  // Keep track of contract destruction
  const [isDestroyed, setIsDestroyed] = useState(false);

  // For unsubscribing from contract events on unmount
  const eventSubscriptions = useRef([]);

  // ----------------------------------------------------------------
  //  Initialization: Web3 + contract
  // ----------------------------------------------------------------
  useEffect(() => {
    (async () => {
      if (window.ethereum) {
        try {
          const _web3 = new Web3(window.ethereum);
          await window.ethereum.request({ method: "eth_requestAccounts" });
          setWeb3(_web3);

          const _accounts = await _web3.eth.getAccounts();
          setAccounts(_accounts);
          setCurrentUser(_accounts[0] || "");

          // Create contract instance
          const _contract = new _web3.eth.Contract(
            CrowdfundingABI,
            CONTRACT_ADDRESS
          );
          setContract(_contract);
        } catch (error) {
          console.error("Error initializing web3:", error);
        }
      } else {
        alert("Please install MetaMask!");
      }
    })();
  }, []);

  // ----------------------------------------------------------------
  //  Once contract + accounts are ready, fetch data
  // ----------------------------------------------------------------
  useEffect(() => {
    if (contract && accounts.length > 0 && web3) {
      fetchGlobalInfo();
      fetchCampaignLists();
      setupContractEventListeners();
      setupMetamaskEventListeners();
    }

    // Cleanup on unmount
    return () => {
      eventSubscriptions.current.forEach((sub) => {
        if (sub.unsubscribe) sub.unsubscribe();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, accounts, web3, currentUser, isDestroyed]);

  // ----------------------------------------------------------------
  //  Set up contract event listeners (no setInterval)
  // ----------------------------------------------------------------
  const setupContractEventListeners = () => {
    if (!contract) return;

    // CampaignCreated
    const subCreated = contract.events.CampaignCreated();

    subCreated.on("data", () => {
      fetchCampaignLists();
    });

    // PledgeMade
    const subPledge = contract.events.PledgeMade();

    subPledge.on("data", () => {
      fetchCampaignLists();
      fetchGlobalInfo();
    });

    // CampaignCancelled
    const subCancelled = contract.events.CampaignCancelled();

    subCancelled.on("data", () => {
      fetchCampaignLists();
      checkIfRefundOwed();
    });

    // CampaignCompleted
    const subCompleted = contract.events.CampaignCompleted();

    subCompleted.on("data", () => {
      fetchCampaignLists();
      fetchGlobalInfo();
    });

    // RefundIssued
    const subRefund = contract.events.RefundIssued();

    subRefund.on("data", () => {
      fetchCampaignLists();
      checkIfRefundOwed();
      fetchGlobalInfo();
    });

    // EntrepreneurBanned
    const subBan = contract.events.EntrepreneurBanned();

    subBan.on("data", () => {
      fetchCampaignLists();
      checkIfRefundOwed();
    });

    // OwnershipTransferred
    const subTransfer = contract.events.OwnershipTransferred();

    subTransfer.on("data", () => {
      fetchGlobalInfo();
    });

    //FeesWithdrawn
    const subFees = contract.events.FeesWithdrawn();

    subFees.on("data", () => {
      fetchGlobalInfo();
    });

    // ContractDestroyed
    const subDestroyed = contract.events.ContractDestroyed();

    subDestroyed.on("data", () => {
      setIsDestroyed(true);
      fetchCampaignLists();
    });

    // Keep references to unsubscribe later
    eventSubscriptions.current = [
      subCreated,
      subPledge,
      subCancelled,
      subCompleted,
      subRefund,
      subBan,
      subTransfer,
      subFees,
      subDestroyed,
    ];
  };

  // ----------------------------------------------------------------
  //  Listen for MetaMask events (account/chain changes)
  // ----------------------------------------------------------------
  const setupMetamaskEventListeners = () => {
    if (window.ethereum) {
      window.ethereum.on("accountsChanged", (accs) => {
        setAccounts(accs);
        setCurrentUser(accs[0] || "");
        fetchCampaignLists();
        fetchGlobalInfo();
      });
      window.ethereum.on("chainChanged", () => {
        // Usually best to reload
        window.location.reload();
      });
    }
  };

  // ----------------------------------------------------------------
  //  Fetch Global Info: Owner, user balance, contract fees, destroyed?
  // ----------------------------------------------------------------
  const fetchGlobalInfo = async () => {
    try {
      const _owner = await contract.methods.owner().call();
      setOwnerAddress(_owner);

      // Check if destroyed
      const _destroyed = await contract.methods.destroyed().call();
      setIsDestroyed(_destroyed);

      // Get user’s own balance in ETH
      updateUserBalance();

      if (!_destroyed) {
        // Fees info
        const feesInfo = await contract.methods.getWithdrawableFees().call();
        // feesInfo.totalCampaignFees, feesInfo.platformFees, feesInfo.totalWithdrawable
        setCollectedFees(
          parseFloat(
            web3.utils.fromWei(feesInfo.totalWithdrawable.toString(), "ether")
          ).toFixed(4)
        );
      }

      // Check if user is owed refunds
      checkIfRefundOwed();
    } catch (err) {
      console.error("fetchGlobalInfo error:", err);
    }
  };

  const updateUserBalance = async () => {
    if (!web3 || !currentUser) return;
    try {
      const balanceWei = await web3.eth.getBalance(currentUser);
      setUserBalance(web3.utils.fromWei(balanceWei, "ether"));
    } catch (err) {
      console.error("updateUserBalance error:", err);
    }
  };

  // ----------------------------------------------------------------
  //  Check if the user is owed refunds from canceled campaigns
  // ----------------------------------------------------------------
  const checkIfRefundOwed = async () => {
    try {
      if (!currentUser) return;
      const owed = await contract.methods.checkRefundOwed(currentUser).call();
      setHasPendingRefunds(owed);
    } catch (err) {
      console.error("checkIfRefundOwed error:", err);
    }
  };

  // ----------------------------------------------------------------
  //  Fetch all campaign lists
  // ----------------------------------------------------------------
  const fetchCampaignLists = async () => {
    try {
      if (!isDestroyed) {
        const active = await contract.methods.getActiveCampaigns().call();
        setActiveCampaigns(active);

        const fulfilled = await contract.methods.getCompletedCampaigns().call();
        setFulfilledCampaigns(fulfilled);
      }

      const canceled = await contract.methods.getCancelledCampaigns().call();
      setCancelledCampaigns(canceled);
    } catch (err) {
      console.error("fetchCampaignLists error:", err);
    }
  };

  // ----------------------------------------------------------------
  //  Handlers for UI interactions
  // ----------------------------------------------------------------

  const checkIsOwner = () => {
    return (
      currentUser.toLowerCase() === ownerAddress.toLowerCase() ||
      currentUser.toLowerCase() === SECONDARY_OWNER.toLowerCase()
    );
  };

  // Create a new campaign
  const handleCreateCampaign = async () => {
    if (!campaignTitle || !campaignPledgeCost || !campaignPledgesNeeded) {
      alert("Please fill out all fields for the new campaign.");
      return;
    }
    if (checkIsOwner()) {
      alert("Owner cannot create campaigns.");
      return;
    }

    try {
      await contract.methods
        .createCampaign(
          campaignTitle,
          web3.utils.toWei(campaignPledgeCost, "ether"),
          campaignPledgesNeeded
        )
        .send({
          from: currentUser,
          // Must match 0.02 ETH creation fee
          value: web3.utils.toWei("0.02", "ether"),
        });

      // Reset form fields
      setCampaignTitle("");
      setCampaignPledgeCost("");
      setCampaignPledgesNeeded("");
    } catch (err) {
      console.error("handleCreateCampaign error:", err);
      alert("Error creating campaign. See console for details.");
    }
  };

  // Pledge to a campaign (buy shares)
  const handlePledge = async (campaignId, shares, pledgeCostWei) => {
    if (isDestroyed) return;
    try {
      const totalCost = BigInt(pledgeCostWei) * BigInt(shares);
      await contract.methods.invest(campaignId, shares).send({
        from: currentUser,
        value: totalCost.toString(), // in Wei
      });
    } catch (err) {
      console.error("handlePledge error:", err);
      alert("Error pledging. See console for details.");
    }
  };

  // Cancel a campaign
  const handleCancelCampaign = async (campaignId) => {
    if (isDestroyed) return;
    try {
      await contract.methods.cancelCampaign(campaignId).send({
        from: currentUser,
      });
    } catch (err) {
      console.error("handleCancelCampaign error:", err);
      alert("Error cancelling campaign. See console for details.");
    }
  };

  // Complete (fulfill) a campaign
  const handleCompleteCampaign = async (campaignId) => {
    if (isDestroyed) return;
    try {
      await contract.methods.completeCampaign(campaignId).send({
        from: currentUser,
      });
    } catch (err) {
      console.error("handleCompleteCampaign error:", err);
      alert("Error completing campaign. See console for details.");
    }
  };

  // Claim refunds for all canceled campaigns
  const handleClaimRefund = async () => {
    try {
      await contract.methods.claimRefund().send({
        from: currentUser,
      });
      // updateUserBalance();
    } catch (err) {
      console.error("handleClaimRefund error:", err);
      alert("Error claiming refund. See console for details.");
    }

    setHasPendingRefunds(false);
  };

  // Owner: withdraw fees
  const handleWithdrawFees = async () => {
    try {
      await contract.methods.withdrawFees().send({
        from: currentUser,
      });
      // updateUserBalance();
    } catch (err) {
      console.error("handleWithdrawFees error:", err);
      alert("Error withdrawing fees. See console for details.");
    }
  };

  // Owner: destroy contract
  const handleDestroyContract = async () => {
    try {
      await contract.methods.destroyContract().send({
        from: currentUser,
      });
    } catch (err) {
      console.error("handleDestroyContract error:", err);
      alert("Error destroying contract. See console for details.");
    }
  };

  // Owner: transfer ownership
  const handleTransferOwnership = async () => {
    if (!newOwner) {
      alert("Please specify the new owner address.");
      return;
    }
    try {
      await contract.methods.transferOwnership(newOwner).send({
        from: currentUser,
      });
      setNewOwner("");
    } catch (err) {
      console.error("handleTransferOwnership error:", err);
      alert("Error transferring ownership. See console for details.");
    }
  };

  // Owner: ban entrepreneur
  const handleBanEntrepreneur = async () => {
    if (!banAddress) {
      alert("Please specify the entrepreneur address to ban.");
      return;
    }
    try {
      await contract.methods.banEntrepreneur(banAddress).send({
        from: currentUser,
      });
      setBanAddress("");
    } catch (err) {
      console.error("handleBanEntrepreneur error:", err);
      alert("Error banning entrepreneur. See console for details.");
    }
  };

  // ----------------------------------------------------------------
  //  Render
  // ----------------------------------------------------------------

  return (
    <div className="container my-4">
      <h2>Crowdfunding DApp</h2>

      {isDestroyed && (
        <div className="alert alert-danger">
          <strong>Contract Destroyed!</strong> You can only claim refunds from
          canceled campaigns if still owed.
        </div>
      )}

      {/* Basic info */}
      <div className="row mb-3">
        <div className="col">
          <label>Current Address:</label>
          <input
            className="form-control text-black-50"
            type="text"
            value={currentUser}
            readOnly
          />
        </div>
        <div className="col">
          <label>Owner's Address:</label>
          <input
            className="form-control text-black-50"
            type="text"
            value={ownerAddress}
            readOnly
          />
        </div>
        <div className="col">
          <label>Your Balance (ETH):</label>
          <input
            className="form-control text-black-50"
            type="text"
            value={userBalance}
            readOnly
          />
        </div>
        <div className="col">
          <label>Collected Fees (ETH):</label>
          <input
            className="form-control text-black-50"
            type="text"
            value={collectedFees}
            readOnly
          />
        </div>
      </div>

      {/* New Campaign */}
      {!isDestroyed && (
        <div className="card mb-4">
          <div className="card-body">
            <h4>New Campaign</h4>
            <div className="row g-2 mb-2">
              <div className="col-md-4">
                <input
                  className="form-control"
                  placeholder="Title"
                  value={campaignTitle}
                  onChange={(e) => setCampaignTitle(e.target.value)}
                  disabled={checkIsOwner()}
                />
              </div>
              <div className="col-md-3">
                <input
                  className="form-control"
                  placeholder="Pledge cost (ETH)"
                  value={campaignPledgeCost}
                  onChange={(e) => setCampaignPledgeCost(e.target.value)}
                  disabled={checkIsOwner()}
                />
              </div>
              <div className="col-md-3">
                <input
                  className="form-control"
                  placeholder="Pledges needed"
                  value={campaignPledgesNeeded}
                  onChange={(e) => setCampaignPledgesNeeded(e.target.value)}
                  disabled={checkIsOwner()}
                />
              </div>
              <div className="col-md-2">
                <button
                  className="btn btn-primary w-100"
                  onClick={handleCreateCampaign}
                  disabled={checkIsOwner()}
                >
                  Create
                </button>
              </div>
            </div>
            <small className="text-muted">
              *Requires 0.02 ETH campaign creation fee.
            </small>
          </div>
        </div>
      )}

      {/* Active Campaigns */}
      {!isDestroyed && (
        <div className="mb-4">
          <h4>Live Campaigns</h4>
          <table className="table table-bordered">
            <thead>
              <tr>
                <th>Entrepreneur</th>
                <th>Title</th>
                <th>Price (ETH)</th>
                <th>Backers</th>
                <th># Pledged</th>
                <th># Needed</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {activeCampaigns.map((c) => {
                const pledgeCostEth = web3.utils.fromWei(c.pledgeCost, "ether");
                const pledgesNeeded = parseInt(c.pledgesNeeded);
                const pledgesCount = parseInt(c.pledgesCount);
                const isFulfilled = pledgesCount >= pledgesNeeded;

                return (
                  <tr key={c.campaignId}>
                    <td>{c.entrepreneur}</td>
                    <td>{c.title}</td>
                    <td>{pledgeCostEth}</td>
                    <td>{c.backers.length}</td>
                    <td>{c.pledgesCount}</td>
                    <td>{c.pledgesNeeded}</td>
                    <td>
                      {/* Buy 1 share */}
                      <button
                        className="btn btn-sm btn-success me-2"
                        onClick={() =>
                          handlePledge(
                            c.campaignId,
                            1,
                            c.pledgeCost // Wei
                          )
                        }
                      >
                        Pledge 1
                      </button>
                      {/* Cancel if entrepreneur or owner */}
                      {(currentUser.toLowerCase() ===
                        c.entrepreneur.toLowerCase() ||
                        checkIsOwner()) && (
                        <button
                          className="btn btn-sm btn-danger me-2"
                          onClick={() => handleCancelCampaign(c.campaignId)}
                        >
                          Cancel
                        </button>
                      )}
                      {/* Fulfill if entrepreneur or owner */}
                      {(currentUser.toLowerCase() ===
                        c.entrepreneur.toLowerCase() ||
                        checkIsOwner()) && (
                        <button
                          className="btn btn-sm btn-warning"
                          style={{
                            opacity: !isFulfilled ? 0.4 : 1,
                          }}
                          onClick={() => handleCompleteCampaign(c.campaignId)}
                          disabled={!isFulfilled}
                        >
                          Fulfill
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Fulfilled Campaigns */}
      {!isDestroyed && (
        <div className="mb-4">
          <h4>Fulfilled Campaigns</h4>
          <table className="table table-bordered">
            <thead>
              <tr>
                <th>Entrepreneur</th>
                <th>Title</th>
                <th>Price (ETH)</th>
                <th>Backers</th>
                <th>Pledges Sold</th>
              </tr>
            </thead>
            <tbody>
              {fulfilledCampaigns.map((c) => (
                <tr key={c.campaignId}>
                  <td>{c.entrepreneur}</td>
                  <td>{c.title}</td>
                  <td>{web3.utils.fromWei(c.pledgeCost, "ether")}</td>
                  <td>{c.backers.length}</td>
                  <td>{c.pledgesCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Canceled Campaigns */}
      <div className="mb-4">
        <h4 className="d-inline">Canceled Campaigns</h4>
        {hasPendingRefunds && (
          <button
            className="btn btn-sm btn-secondary ms-3 mb-1 d-inline"
            onClick={handleClaimRefund}
          >
            Claim
          </button>
        )}
        <table className="table table-bordered">
          <thead>
            <tr>
              <th>Entrepreneur</th>
              <th>Title</th>
              <th>Price (ETH)</th>
              <th>Backers</th>
              <th>Pledges</th>
            </tr>
          </thead>
          <tbody>
            {cancelledCampaigns.map((c) => (
              <tr key={c.campaignId}>
                <td>{c.entrepreneur}</td>
                <td>{c.title}</td>
                <td>{web3.utils.fromWei(c.pledgeCost, "ether")}</td>
                <td>{c.backers.length}</td>
                <td>{c.pledgesCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Owner Control Panel */}
      {checkIsOwner() && !isDestroyed && (
        <div className="card mb-4">
          <div className="card-body">
            <h4>Control Panel (Owner Only)</h4>
            <div className="row g-2 mb-3">
              <div className="col-md-3">
                <button
                  className="btn btn-info w-100"
                  onClick={handleWithdrawFees}
                >
                  Withdraw Fees
                </button>
              </div>
              <div className="col-md-3">
                <button
                  className="btn btn-danger w-100"
                  onClick={handleDestroyContract}
                >
                  Destroy Contract
                </button>
              </div>
            </div>

            <div className="row g-2 mb-3">
              <div className="col-md-4">
                <input
                  type="text"
                  className="form-control"
                  placeholder="New Owner Address"
                  value={newOwner}
                  onChange={(e) => setNewOwner(e.target.value)}
                />
              </div>
              <div className="col-md-3">
                <button
                  className="btn btn-primary w-100"
                  onClick={handleTransferOwnership}
                >
                  Transfer Ownership
                </button>
              </div>
            </div>

            <div className="row g-2 mb-3">
              <div className="col-md-4">
                <input
                  type="text"
                  className="form-control"
                  placeholder="Address to Ban"
                  value={banAddress}
                  onChange={(e) => setBanAddress(e.target.value)}
                />
              </div>
              <div className="col-md-3">
                <button
                  className="btn btn-warning w-100"
                  onClick={handleBanEntrepreneur}
                >
                  Ban Entrepreneur
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
