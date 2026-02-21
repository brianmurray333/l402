(function () {
  "use strict";

  var lottery = window.__LOTTERY__ || null;
  var history = window.__LOTTERY_HISTORY__ || [];
  var l402Enabled = window.__L402_ENABLED__ || false;

  // ── DOM refs ──
  var potAmountEl = document.getElementById("pot-amount");
  var entryCountEl = document.getElementById("entry-count");
  var countdownEl = document.getElementById("countdown");
  var buyBtn = document.getElementById("buy-ticket-btn");
  var entriesList = document.getElementById("entries-list");
  var historyList = document.getElementById("history-list");

  // Modal
  var modal = document.getElementById("ticket-modal");
  var modalClose = document.getElementById("ticket-modal-close");
  var formStep = document.getElementById("ticket-form-step");
  var paymentStep = document.getElementById("ticket-payment-step");
  var confirmedStep = document.getElementById("ticket-confirmed-step");

  var lnAddressInput = document.getElementById("ticket-ln-address");
  var nodePubkeyInput = document.getElementById("ticket-node-pubkey");
  var fieldLnAddress = document.getElementById("field-ln-address");
  var fieldNodePubkey = document.getElementById("field-node-pubkey");
  var payoutLabel = document.getElementById("payout-label");
  var payoutMenuBtns = [document.getElementById("payout-menu-btn"), document.getElementById("payout-menu-btn-2")];
  var payoutMenus = [document.getElementById("payout-menu"), document.getElementById("payout-menu-2")];
  var currentPayoutMethod = "lightning_address";
  var amountInput = document.getElementById("ticket-amount");
  var oddsEl = document.getElementById("ticket-odds");
  var getInvoiceBtn = document.getElementById("ticket-get-invoice");
  var formStatus = document.getElementById("ticket-form-status");

  var qrImg = document.getElementById("ticket-qr");
  var invoiceText = document.getElementById("ticket-invoice-text");
  var copyBtn = document.getElementById("ticket-copy-btn");
  var paymentStatus = document.getElementById("ticket-payment-status");

  var confirmedMsg = document.getElementById("ticket-confirmed-msg");

  var pollInterval = null;
  var countdownInterval = null;
  var pendingMacaroon = null;
  var pendingPaymentHash = null;

  // ── Format helpers ──
  function formatSats(n) {
    return Number(n || 0).toLocaleString();
  }

  function timeAgo(isoString) {
    var diff = Date.now() - new Date(isoString).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    var days = Math.floor(hrs / 24);
    return days + "d ago";
  }

  function formatCountdown(ms) {
    if (ms <= 0) return "00:00:00";
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    s -= h * 3600;
    var m = Math.floor(s / 60);
    s -= m * 60;
    return (
      String(h).padStart(2, "0") +
      ":" +
      String(m).padStart(2, "0") +
      ":" +
      String(s).padStart(2, "0")
    );
  }

  // ── Render ──
  function renderPot() {
    if (!lottery) return;
    potAmountEl.innerHTML =
      formatSats(lottery.totalPot) +
      ' <span class="pot-amount-unit">sats</span>';
    entryCountEl.textContent = lottery.entryCount || 0;
  }

  function renderEntries() {
    if (!lottery || !lottery.entries || lottery.entries.length === 0) {
      entriesList.innerHTML =
        '<div class="lottery-empty">No entries yet. Be the first!</div>';
      return;
    }

    var sorted = lottery.entries.slice().reverse();
    entriesList.innerHTML = sorted
      .slice(0, 20)
      .map(function (e) {
        return (
          '<div class="lottery-entry-row">' +
          '<span class="entry-amount">⚡ ' +
          formatSats(e.amountSats) +
          " sats</span>" +
          '<span class="entry-time">' +
          timeAgo(e.paidAt) +
          "</span>" +
          "</div>"
        );
      })
      .join("");
  }

  function renderHistory() {
    if (!history || history.length === 0) {
      historyList.innerHTML =
        '<div class="lottery-empty">No completed lotteries yet.</div>';
      return;
    }

    historyList.innerHTML = history
      .map(function (l) {
        if (!l.winner || l.entryCount === 0) {
          return (
            '<div class="lottery-history-item">' +
            '<div><span class="history-winner">No entries</span>' +
            '<div class="history-date">' +
            new Date(l.endsAt).toLocaleDateString() +
            "</div></div>" +
            '<span class="history-status history-status--noentries">No draw</span>' +
            "</div>"
          );
        }
        var statusClass =
          l.winner.payoutStatus === "paid"
            ? "history-status--paid"
            : "history-status--failed";
        var statusText =
          l.winner.payoutStatus === "paid" ? "Paid" : "Pending";
        return (
          '<div class="lottery-history-item">' +
          '<div><span class="history-winner"><strong>' +
          l.winner.maskedAddress +
          "</strong> won " +
          formatSats(l.winner.payout) +
          " sats</span>" +
          '<div class="history-date">' +
          new Date(l.endsAt).toLocaleDateString() +
          " · " +
          l.entryCount +
          " entries</div></div>" +
          '<span class="history-status ' +
          statusClass +
          '">' +
          statusText +
          "</span>" +
          "</div>"
        );
      })
      .join("");
  }

  function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    function tick() {
      if (!lottery) return;
      var remaining = new Date(lottery.endsAt).getTime() - Date.now();
      countdownEl.textContent = formatCountdown(remaining);
      if (remaining <= 0) {
        countdownEl.textContent = "Drawing...";
        clearInterval(countdownInterval);
        // Refresh lottery state
        setTimeout(refreshLottery, 3000);
      }
    }
    tick();
    countdownInterval = setInterval(tick, 1000);
  }

  function updateOdds() {
    var amount = parseInt(amountInput.value || 0, 10);
    if (!lottery || amount <= 0) {
      oddsEl.textContent = "";
      return;
    }
    var total = (lottery.totalPot || 0) + amount;
    var pct = ((amount / total) * 100).toFixed(1);
    oddsEl.textContent = "Your odds: ~" + pct + "% (" + formatSats(amount) + " / " + formatSats(total) + " sats)";
  }

  // ── API ──
  function refreshLottery() {
    fetch("/api/lottery")
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        lottery = data;
        renderPot();
        renderEntries();
        startCountdown();
      })
      .catch(function () {});

    fetch("/api/lottery/history")
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        history = data;
        renderHistory();
      })
      .catch(function () {});
  }

  // ── Modal ──
  function openModal() {
    formStep.style.display = "";
    paymentStep.classList.remove("is-active");
    confirmedStep.classList.remove("is-active");
    formStatus.textContent = "";
    formStatus.className = "ticket-status";
    getInvoiceBtn.disabled = false;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    updateOdds();
  }

  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  buyBtn.addEventListener("click", openModal);
  modalClose.addEventListener("click", closeModal);
  modal.addEventListener("click", function (e) {
    if (e.target === modal) closeModal();
  });

  amountInput.addEventListener("input", updateOdds);

  // ── Payout method menu ──
  function closeAllPayoutMenus() {
    payoutMenus.forEach(function (m) { if (m) m.classList.remove("is-open"); });
  }

  function switchPayoutMethod(method) {
    currentPayoutMethod = method;
    closeAllPayoutMenus();
    // Update active state on all menu items
    document.querySelectorAll(".payout-menu-item").forEach(function (item) {
      item.classList.toggle("is-active", item.getAttribute("data-method") === method);
    });
    if (method === "lightning_address") {
      fieldLnAddress.style.display = "";
      fieldNodePubkey.style.display = "none";
    } else {
      fieldLnAddress.style.display = "none";
      fieldNodePubkey.style.display = "";
    }
  }

  payoutMenuBtns.forEach(function (btn) {
    if (!btn) return;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var menu = btn.nextElementSibling;
      var isOpen = menu.classList.contains("is-open");
      closeAllPayoutMenus();
      if (!isOpen) menu.classList.add("is-open");
    });
  });

  document.querySelectorAll(".payout-menu-item").forEach(function (item) {
    item.addEventListener("click", function (e) {
      e.stopPropagation();
      switchPayoutMethod(item.getAttribute("data-method"));
    });
  });

  // Close menus when clicking elsewhere
  document.addEventListener("click", function () {
    closeAllPayoutMenus();
  });

  // ── Get Invoice ──
  getInvoiceBtn.addEventListener("click", function () {
    var address = (lnAddressInput.value || "").trim();
    var pubkey = (nodePubkeyInput.value || "").trim();
    var amount = parseInt(amountInput.value || 0, 10);

    if (currentPayoutMethod === "lightning_address") {
      if (!address || !address.includes("@")) {
        formStatus.textContent = "Please enter a valid Lightning Address (e.g. you@wallet.com)";
        formStatus.className = "ticket-status ticket-status--error";
        return;
      }
    } else {
      if (!pubkey || !/^(02|03)[0-9a-fA-F]{64}$/.test(pubkey)) {
        formStatus.textContent = "Please enter a valid node pubkey (66 hex chars starting with 02 or 03)";
        formStatus.className = "ticket-status ticket-status--error";
        return;
      }
    }

    if (amount < 10) {
      formStatus.textContent = "Minimum entry is 10 sats.";
      formStatus.className = "ticket-status ticket-status--error";
      return;
    }
    if (amount > 1000000) {
      formStatus.textContent = "Maximum entry is 1,000,000 sats.";
      formStatus.className = "ticket-status ticket-status--error";
      return;
    }

    getInvoiceBtn.disabled = true;
    formStatus.textContent = "Creating invoice...";
    formStatus.className = "ticket-status";

    var body = { amountSats: amount };
    if (currentPayoutMethod === "lightning_address") {
      body.lightningAddress = address;
    } else {
      body.nodePubkey = pubkey;
    }

    fetch("/api/lottery/enter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { status: r.status, data: data };
        });
      })
      .then(function (result) {
        if (result.status === 402 && result.data.invoice) {
          // Show payment step
          pendingMacaroon = result.data.macaroon;
          pendingPaymentHash = result.data.paymentHash;

          if (result.data.qrCode) {
            qrImg.src = result.data.qrCode;
          } else {
            qrImg.src = "/api/l402/qr/" + result.data.paymentHash;
          }
          invoiceText.value = result.data.invoice;
          paymentStatus.textContent = "Waiting for payment...";
          paymentStatus.className = "ticket-status";

          formStep.style.display = "none";
          paymentStep.classList.add("is-active");

          // Start polling — pass the body so the L402 confirmation re-sends it
          startPaymentPolling(body);
        } else if (result.data.error) {
          formStatus.textContent = result.data.error;
          formStatus.className = "ticket-status ticket-status--error";
          getInvoiceBtn.disabled = false;
        } else {
          formStatus.textContent = "Unexpected response.";
          formStatus.className = "ticket-status ticket-status--error";
          getInvoiceBtn.disabled = false;
        }
      })
      .catch(function (err) {
        formStatus.textContent = "Network error: " + err.message;
        formStatus.className = "ticket-status ticket-status--error";
        getInvoiceBtn.disabled = false;
      });
  });

  // ── Copy Invoice ──
  copyBtn.addEventListener("click", function () {
    navigator.clipboard
      .writeText(invoiceText.value)
      .then(function () {
        copyBtn.textContent = "Copied!";
        setTimeout(function () {
          copyBtn.textContent = "Copy";
        }, 2000);
      })
      .catch(function () {});
  });

  // ── Payment Polling ──
  function startPaymentPolling(entryBody) {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(function () {
      fetch("/api/l402/check/" + pendingPaymentHash)
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (data.paid) {
            clearInterval(pollInterval);
            pollInterval = null;
            paymentStatus.textContent = "Payment received! Recording entry...";
            paymentStatus.className = "ticket-status ticket-status--success";

            // Submit the L402 token
            var token = pendingMacaroon + ":" + data.preimage;
            return fetch("/api/lottery/enter", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "L402 " + token,
              },
              body: JSON.stringify(entryBody),
            })
              .then(function (r2) {
                return r2.json();
              })
              .then(function (result) {
                if (result.success) {
                  // Update local lottery state
                  lottery = result.lottery;
                  renderPot();
                  renderEntries();

                  // Show confirmation
                  paymentStep.classList.remove("is-active");
                  confirmedStep.classList.add("is-active");
                  confirmedMsg.textContent =
                    "Your " +
                    formatSats(amount) +
                    " sat entry is in! The pot is now " +
                    formatSats(lottery.totalPot) +
                    " sats. Good luck!";
                } else {
                  paymentStatus.textContent =
                    result.error || "Entry recording failed.";
                  paymentStatus.className =
                    "ticket-status ticket-status--error";
                }
              });
          }
        })
        .catch(function () {});
    }, 2500);
  }

  // ── Init ──
  renderPot();
  renderEntries();
  renderHistory();
  startCountdown();

  // Auto-refresh every 30 seconds
  setInterval(refreshLottery, 30000);
})();
