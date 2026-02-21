/* -- DOM References -- */
var tileGrid = document.querySelector("[data-tile-grid]");
var liveCount = document.querySelector("[data-live-count]");

// Unified submission
var submissionForm = document.querySelector("#submission-form");
var submitBtn = document.querySelector("#submit-btn");
var paywallNote = document.querySelector("#paywall-note");

// App confirmation modal
var confirmModal = document.querySelector("#confirm-modal");
var confirmForm = document.querySelector("#confirm-form");
var confirmStatus = document.querySelector("[data-confirm-status]");
var previewName = document.querySelector("[data-preview-name]");
var previewImage = document.querySelector("[data-preview-image]");
var confirmName = document.querySelector("#confirm-name");
var confirmUrl = document.querySelector("#confirm-url");
var confirmDescription = document.querySelector("#confirm-description");
var confirmImage = document.querySelector("#confirm-image");
var confirmIcon = document.querySelector("#confirm-icon");
var saveBtn = document.querySelector("#save-btn");
var confirmBody = document.querySelector("#confirm-body");
var paymentStep = document.querySelector("#payment-step");
var paymentQrImg = document.querySelector("#payment-qr");
var paymentInvoiceText = document.querySelector("#payment-invoice-text");
var copyInvoiceBtn = document.querySelector("#copy-invoice");
var paymentStatusEl = document.querySelector("#payment-status");
var cancelPaymentBtn = document.querySelector("#cancel-payment");
var paymentAmountEl = document.querySelector("#payment-amount");

// API confirmation modal
var apiConfirmModal = document.querySelector("#api-confirm-modal");
var apiConfirmForm = document.querySelector("#api-confirm-form");
var apiConfirmStatus = document.querySelector("[data-api-confirm-status]");
var apiVerifyProvider = document.querySelector("#api-verify-provider");
var apiVerifyMethod = document.querySelector("#api-verify-method");
var apiVerifyEndpoint = document.querySelector("#api-verify-endpoint");
var apiVerifyCost = document.querySelector("#api-verify-cost");
var apiVerifyDescription = document.querySelector("#api-verify-description");
var apiInvoiceInput = document.querySelector("#api-invoice");
var apiEditDescription = document.querySelector("#api-edit-description");
var apiSaveBtn = document.querySelector("#api-save-btn");

// Boost
var boostModal = document.querySelector("#boost-modal");
var boostPaymentStep = document.querySelector("#boost-payment-step");
var boostItemName = document.querySelector("#boost-item-name");
var boostPaymentAmountEl = document.querySelector("#boost-payment-amount");
var boostPaymentQrImg = document.querySelector("#boost-payment-qr");
var boostPaymentInvoiceText = document.querySelector("#boost-payment-invoice-text");
var boostCopyInvoiceBtn = document.querySelector("#boost-copy-invoice");
var boostPaymentStatusEl = document.querySelector("#boost-payment-status");

/* -- State -- */
var appsData = window.__APPS__ || [];
var apisData = window.__APIS__ || [];
var currentBoostPrice = window.__BOOST_PRICE__ || 21;
var l402Enabled = window.__L402_ENABLED__ || false;

var pendingApp = null;
var pendingApiVerification = null;
var l402State = null;
var pollTimer = null;

var boostTarget = null;
var boostL402State = null;
var boostPollTimer = null;

/* -- Helpers -- */
var toHost = function (value) {
  try { return new URL(value).host.replace(/^www\./, ""); }
  catch (e) { return value; }
};

var showToast = function (message) {
  var existing = document.querySelector(".toast");
  if (existing) existing.remove();
  var toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(function () { toast.classList.add("toast--visible"); });
  setTimeout(function () {
    toast.classList.remove("toast--visible");
    setTimeout(function () { toast.remove(); }, 300);
  }, 2000);
};

var copyEndpointToClipboard = function (text) {
  navigator.clipboard.writeText(text).then(function () {
    showToast("Copied to clipboard");
  });
};

/* -- App Confirmation Modal -- */
var openModal = function () {
  confirmModal.classList.add("is-open");
  confirmModal.setAttribute("aria-hidden", "false");
  showConfirmBody();
};

var closeModal = function () {
  confirmModal.classList.remove("is-open");
  confirmModal.setAttribute("aria-hidden", "true");
  confirmStatus.textContent = "";
  pendingApp = null;
  stopPolling();
  l402State = null;
  showConfirmBody();
};

var showConfirmBody = function () {
  confirmBody.style.display = "";
  paymentStep.style.display = "none";
};

var showPaymentStep = function () {
  confirmBody.style.display = "none";
  paymentStep.style.display = "flex";
};

var syncPreview = function () {
  previewName.textContent = confirmName.value || "App name";
  var image = confirmImage.value.trim() || confirmIcon.value.trim();
  previewImage.style.backgroundImage = image ? 'url("' + image + '")' : "none";
};

var getTileImage = function (app) { return app.image || app.icon || ""; };

var externalLinkSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';

var buildHoverHeader = function (app) {
  var header = document.createElement("div");
  header.className = "hovercard-header";
  var left = document.createElement("div");
  left.className = "hovercard-header-left";

  if (app.icon) {
    var iconWrap = document.createElement("div");
    iconWrap.className = "hover-icon";
    var ic = document.createElement("img");
    ic.src = app.icon;
    ic.alt = app.name + " icon";
    ic.loading = "lazy";
    iconWrap.appendChild(ic);
    left.appendChild(iconWrap);
  }

  var name = document.createElement("h4");
  name.textContent = app.name;
  left.appendChild(name);

  var extLink = document.createElement("a");
  extLink.className = "hovercard-ext-link";
  extLink.href = app.url;
  extLink.target = "_blank";
  extLink.rel = "noreferrer";
  extLink.setAttribute("aria-label", "Open " + app.name);
  extLink.innerHTML = externalLinkSvg;
  extLink.addEventListener("click", function (e) { e.stopPropagation(); });

  header.appendChild(left);
  header.appendChild(extLink);
  return header;
};

/* -- App Detail Modal -- */
var appDetailModal = document.querySelector("#app-detail-modal");
var appDetailIcon = document.querySelector("#app-detail-icon");
var appDetailTitle = document.querySelector("#app-detail-title");
var appDetailDesc = document.querySelector("#app-detail-description");
var appDetailLink = document.querySelector("#app-detail-link");
var appDetailBoost = document.querySelector("#app-detail-boost");

var openAppDetailModal = function (app) {
  if (app.icon) {
    appDetailIcon.src = app.icon;
    appDetailIcon.style.display = "";
  } else {
    appDetailIcon.style.display = "none";
  }
  appDetailTitle.textContent = app.name;
  appDetailDesc.textContent = app.description || "No description provided yet.";
  appDetailLink.href = app.url;
  appDetailLink.innerHTML = 'Visit <span class="app-detail-visit-arrow">\u2192</span>';

  appDetailBoost.onclick = function () {
    closeAppDetailModal();
    startBoostFlow(app.id || app.url, "app", app.name);
  };

  appDetailModal.classList.add("is-open");
  appDetailModal.setAttribute("aria-hidden", "false");
};

var closeAppDetailModal = function () {
  appDetailModal.classList.remove("is-open");
  appDetailModal.setAttribute("aria-hidden", "true");
};

document.querySelectorAll("[data-app-detail-close]").forEach(function (btn) {
  btn.addEventListener("click", closeAppDetailModal);
});
var appDetailMouseDownTarget = null;
appDetailModal.addEventListener("mousedown", function (e) {
  appDetailMouseDownTarget = e.target;
});
appDetailModal.addEventListener("click", function (e) {
  if (e.target === appDetailModal && appDetailMouseDownTarget === appDetailModal) closeAppDetailModal();
  appDetailMouseDownTarget = null;
});

var supportsHover = window.matchMedia("(hover: hover)").matches;

var createTile = function (app) {
  var tile = document.createElement("div");
  tile.className = "app-tile" + (app.boost ? " app-tile--boosted" : "");
  tile.setAttribute("role", "button");
  tile.setAttribute("tabindex", "0");
  tile.setAttribute("aria-label", app.name);

  var imageUrl = getTileImage(app);
  if (imageUrl) {
    var image = document.createElement("div");
    image.className = "tile-image";
    image.style.backgroundImage = 'url("' + imageUrl + '")';
    tile.appendChild(image);
  }

  if (app.boost) {
    var bb = document.createElement("div");
    bb.className = "tile-boost-badge";
    bb.textContent = "\u26A1";
    tile.appendChild(bb);
  }

  var nameLabel = document.createElement("div");
  nameLabel.className = "tile-name";
  nameLabel.textContent = app.name;

  var hover = document.createElement("div");
  hover.className = "hovercard";
  var hoverDesc = document.createElement("p");
  hoverDesc.textContent = app.description || "No description provided yet.";

  var hoverActions = document.createElement("div");
  hoverActions.className = "hovercard-actions";

  var visitBtn = document.createElement("a");
  visitBtn.className = "hovercard-visit-btn";
  visitBtn.href = app.url;
  visitBtn.target = "_blank";
  visitBtn.rel = "noreferrer";
  visitBtn.textContent = "Visit →";
  visitBtn.addEventListener("click", function (e) { e.stopPropagation(); });

  var boostBtn = document.createElement("button");
  boostBtn.className = "hovercard-boost-btn";
  boostBtn.textContent = "⚡ Boost";
  boostBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    startBoostFlow(app.id || app.url, "app", app.name);
  });

  hoverActions.append(visitBtn, boostBtn);
  hover.append(buildHoverHeader(app), hoverDesc, hoverActions);
  tile.append(nameLabel, hover);

  tile.addEventListener("click", function () {
    // On touch devices (no hover), open the modal
    if (!supportsHover) {
      openAppDetailModal(app);
    }
    // On desktop, the hovercard has visit+boost, no modal needed
  });

  return tile;
};

var renderApps = function (apps) {
  tileGrid.innerHTML = "";
  apps.forEach(function (app) { tileGrid.appendChild(createTile(app)); });
  if (liveCount) liveCount.textContent = apps.length.toString();
};

var updateConfirmationFields = function (metadata) {
  confirmName.value = metadata.name || "";
  confirmUrl.value = metadata.url || "";
  confirmDescription.value = metadata.description || "";
  confirmImage.value = metadata.image || "";
  confirmIcon.value = metadata.icon || "";
  syncPreview();
};

var setStatus = function (message, isError) {
  confirmStatus.textContent = message;
  confirmStatus.style.color = isError ? "#f8b4ff" : "var(--muted)";
};

/* -- L402 Payment Flow (for app submission) -- */
var stopPolling = function () {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
};

var startPaymentFlow = function (data) {
  l402State = { macaroon: data.macaroon, invoice: data.invoice, paymentHash: data.paymentHash };
  if (paymentAmountEl) paymentAmountEl.textContent = data.amountSats || 100;
  paymentInvoiceText.value = data.invoice;
  paymentStatusEl.textContent = "Waiting for payment...";
  paymentStatusEl.className = "payment-status";
  if (data.qrCode && paymentQrImg) {
    paymentQrImg.src = data.qrCode;
    paymentQrImg.style.display = "block";
  }
  showPaymentStep();
  stopPolling();
  pollTimer = setInterval(pollPayment, 3000);
};

var pollPayment = async function () {
  if (!l402State) return;
  try {
    var res = await fetch("/api/l402/check/" + l402State.paymentHash);
    var data = await res.json();
    if (data.paid) {
      stopPolling();
      paymentStatusEl.textContent = "Payment received! Submitting...";
      paymentStatusEl.className = "payment-status payment-status--success";
      var l402Token = "L402 " + l402State.macaroon + ":" + data.preimage;
      await submitAppWithToken(l402Token);
    }
  } catch (_err) {}
};

var submitAppWithToken = async function (authToken) {
  var payload = {
    name: confirmName.value.trim(),
    url: confirmUrl.value.trim(),
    description: confirmDescription.value.trim(),
    image: confirmImage.value.trim(),
    icon: confirmIcon.value.trim(),
  };
  try {
    var res = await fetch("/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authToken },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      var errData = await res.json().catch(function () { return {}; });
      throw new Error(errData.error || "Submission failed.");
    }
    var newApp = await res.json();
    appsData.unshift(newApp);
    renderApps(appsData);
    closeModal();
    submissionForm.reset();
    pendingApp = null;
  } catch (error) {
    paymentStatusEl.textContent = "Submission failed: " + error.message;
    paymentStatusEl.className = "payment-status payment-status--error";
  }
};

/* -- API Cards -- */
var apiGrid = document.querySelector("[data-api-grid]");

var createApiCard = function (api) {
  var card = document.createElement("div");
  var cls = "api-card";
  if (api.boost) cls += " api-card--boosted";
  if (api.featured) cls += " api-card--featured";
  card.className = cls;

  var header = document.createElement("div");
  header.className = "api-card-header";
  var headerLeft = document.createElement("div");
  headerLeft.className = "api-card-header-left";

  if (api.icon) {
    var ic = document.createElement("img");
    ic.src = api.icon;
    ic.alt = "";
    ic.className = "api-card-icon";
    ic.onerror = function () { this.style.display = "none"; };
    headerLeft.appendChild(ic);
  }

  var providerName = document.createElement("h3");
  providerName.textContent = api.provider || api.name;
  headerLeft.appendChild(providerName);
  header.appendChild(headerLeft);

  var dirBadge = document.createElement("span");
  var costLabel = "";
  if (api.costType === "variable" || api.cost === null) {
    costLabel = " Variable";
  } else if (api.cost) {
    costLabel = " " + api.cost + " sats";
  }
  if (api.direction === "pays") {
    dirBadge.className = "api-direction-badge api-direction-badge--pays";
    dirBadge.textContent = "\u26A1 Pays" + costLabel;
  } else {
    dirBadge.className = "api-direction-badge api-direction-badge--charges";
    dirBadge.textContent = "\u26A1 Charges" + costLabel;
  }
  header.appendChild(dirBadge);
  card.appendChild(header);

  var endpointRow = document.createElement("div");
  endpointRow.className = "api-endpoint-display";
  var method = document.createElement("span");
  method.className = "api-method api-method--" + (api.method || "GET").toLowerCase();
  method.textContent = api.method || "GET";
  var endpointPath = document.createElement("span");
  endpointPath.className = "api-endpoint-path";
  endpointPath.textContent = api.endpoint || "";
  endpointPath.title = "Click to copy";
  endpointPath.style.cursor = "pointer";
  endpointPath.addEventListener("click", function (e) {
    e.stopPropagation();
    copyEndpointToClipboard(api.endpoint || "");
  });
  var copyBtn = document.createElement("button");
  copyBtn.className = "api-copy-btn";
  copyBtn.title = "Copy URL";
  copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  copyBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    copyEndpointToClipboard(api.endpoint || "");
  });
  endpointRow.append(method, endpointPath, copyBtn);
  card.appendChild(endpointRow);

  if (api.boost) {
    var boostBadge = document.createElement("div");
    boostBadge.className = "api-boost-badge";
    boostBadge.textContent = "\u26A1 Boosted";
    card.appendChild(boostBadge);
  }

  var descRow = document.createElement("div");
  descRow.className = "api-card-desc-row";

  var desc = document.createElement("p");
  desc.className = "api-card-desc";
  desc.textContent = api.description || api.name || "";
  descRow.appendChild(desc);

  var boostBtn = document.createElement("button");
  boostBtn.className = "boost-btn";
  boostBtn.textContent = "\u26A1 Boost";
  boostBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    startBoostFlow(api.id, "api", (api.provider || api.name) + " - " + api.name);
  });
  descRow.appendChild(boostBtn);

  card.appendChild(descRow);
  return card;
};

var renderApis = function (apis) {
  if (!apiGrid) return;
  apiGrid.innerHTML = "";
  apis.forEach(function (api) { apiGrid.appendChild(createApiCard(api)); });
};

/* -- API Confirmation Modal -- */
var openApiModal = function () {
  apiConfirmModal.classList.add("is-open");
  apiConfirmModal.setAttribute("aria-hidden", "false");
};

var closeApiModal = function () {
  apiConfirmModal.classList.remove("is-open");
  apiConfirmModal.setAttribute("aria-hidden", "true");
  if (apiConfirmStatus) apiConfirmStatus.textContent = "";
  pendingApiVerification = null;
  apiInvoiceInput.value = "";
  apiEditDescription.value = "";
};

/* -- Boost Modal -- */
var openBoostModal = function () {
  boostModal.classList.add("is-open");
  boostModal.setAttribute("aria-hidden", "false");
};

var closeBoostModal = function () {
  boostModal.classList.remove("is-open");
  boostModal.setAttribute("aria-hidden", "true");
  boostTarget = null;
  stopBoostPolling();
  boostL402State = null;
};

var stopBoostPolling = function () {
  if (boostPollTimer) { clearInterval(boostPollTimer); boostPollTimer = null; }
};

var startBoostFlow = async function (itemId, itemType, name) {
  boostTarget = { itemId: itemId, itemType: itemType, name: name };
  boostItemName.textContent = name;
  boostPaymentStatusEl.textContent = "Creating invoice...";
  boostPaymentStatusEl.className = "payment-status";
  if (boostPaymentQrImg) boostPaymentQrImg.style.display = "none";
  boostPaymentInvoiceText.value = "";
  openBoostModal();

  try {
    var res = await fetch("/api/boost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: itemId, itemType: itemType }),
    });

    if (res.status === 402) {
      var data = await res.json();
      boostL402State = { macaroon: data.macaroon, invoice: data.invoice, paymentHash: data.paymentHash };
      boostPaymentAmountEl.textContent = data.amountSats;
      boostPaymentInvoiceText.value = data.invoice;
      boostPaymentStatusEl.textContent = "Waiting for payment...";
      boostPaymentStatusEl.className = "payment-status";
      if (data.qrCode && boostPaymentQrImg) {
        boostPaymentQrImg.src = data.qrCode;
        boostPaymentQrImg.style.display = "block";
      }
      stopBoostPolling();
      boostPollTimer = setInterval(pollBoostPayment, 3000);
    } else {
      throw new Error("Unexpected response");
    }
  } catch (err) {
    console.error("Boost error:", err);
    boostPaymentStatusEl.textContent = "Could not create invoice. Please try again.";
    boostPaymentStatusEl.className = "payment-status payment-status--error";
  }
};

var pollBoostPayment = async function () {
  if (!boostL402State) return;
  try {
    var res = await fetch("/api/l402/check/" + boostL402State.paymentHash);
    var data = await res.json();
    if (data.paid) {
      stopBoostPolling();
      boostPaymentStatusEl.textContent = "Payment received! Boosting...";
      boostPaymentStatusEl.className = "payment-status payment-status--success";
      var l402Token = "L402 " + boostL402State.macaroon + ":" + data.preimage;
      var boostRes = await fetch("/api/boost", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: l402Token },
        body: JSON.stringify({ itemId: boostTarget.itemId, itemType: boostTarget.itemType }),
      });
      if (boostRes.ok) {
        boostPaymentStatusEl.textContent = "Boosted! \u26A1";
        setTimeout(function () { closeBoostModal(); window.location.reload(); }, 1500);
      } else {
        var err = await boostRes.json().catch(function () { return {}; });
        boostPaymentStatusEl.textContent = "Boost failed: " + (err.error || "Unknown error");
        boostPaymentStatusEl.className = "payment-status payment-status--error";
      }
    }
  } catch (_err) {}
};

/* -- Event Listeners -- */
document.querySelectorAll("[data-modal-close]").forEach(function (button) {
  button.addEventListener("click", closeModal);
});
confirmModal.addEventListener("click", function (event) {
  if (event.target === confirmModal) closeModal();
});

document.querySelectorAll("[data-api-modal-close]").forEach(function (button) {
  button.addEventListener("click", closeApiModal);
});
apiConfirmModal.addEventListener("click", function (event) {
  if (event.target === apiConfirmModal) closeApiModal();
});

document.querySelectorAll("[data-boost-modal-close]").forEach(function (button) {
  button.addEventListener("click", closeBoostModal);
});
boostModal.addEventListener("click", function (event) {
  if (event.target === boostModal) closeBoostModal();
});

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") {
    if (appDetailModal.classList.contains("is-open")) closeAppDetailModal();
    if (confirmModal.classList.contains("is-open")) closeModal();
    if (apiConfirmModal.classList.contains("is-open")) closeApiModal();
    if (boostModal.classList.contains("is-open")) closeBoostModal();
  }
});

[confirmName, confirmUrl, confirmDescription, confirmImage, confirmIcon].forEach(function (field) {
  field.addEventListener("input", syncPreview);
});

copyInvoiceBtn.addEventListener("click", function () {
  navigator.clipboard.writeText(paymentInvoiceText.value).then(function () {
    copyInvoiceBtn.textContent = "Copied!";
    setTimeout(function () { copyInvoiceBtn.textContent = "Copy"; }, 2000);
  });
});

boostCopyInvoiceBtn.addEventListener("click", function () {
  navigator.clipboard.writeText(boostPaymentInvoiceText.value).then(function () {
    boostCopyInvoiceBtn.textContent = "Copied!";
    setTimeout(function () { boostCopyInvoiceBtn.textContent = "Copy"; }, 2000);
  });
});

cancelPaymentBtn.addEventListener("click", function () {
  stopPolling();
  l402State = null;
  showConfirmBody();
});

/* -- Auto-detect: is URL an API endpoint or an app? -- */
var looksLikeApi = function (url) {
  try {
    var u = new URL(url);
    var p = u.pathname.toLowerCase();
    var h = u.hostname.toLowerCase();
    // Heuristic: path contains /api/, /v1/, /v2/ etc, or host starts with api.
    if (/\/(api|v[0-9]+|graphql|rpc)\b/.test(p)) return true;
    if (h.startsWith("api.")) return true;
    return false;
  } catch (_) { return false; }
};

/* -- Unified Submission Form -- */
submissionForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  var urlInput = document.querySelector("#submit-url");
  var url = urlInput.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  var isApi = looksLikeApi(url);

  submitBtn.disabled = true;
  submitBtn.textContent = isApi ? "Verifying..." : "Fetching...";

  if (isApi) {
    // API flow
    try {
      var response = await fetch("/api/verify-l402", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url }),
      });
      var data = await response.json();
      if (!response.ok) throw new Error(data.error || "Verification failed.");

      pendingApiVerification = data;
      apiVerifyProvider.textContent = data.provider || "Unknown";
      apiVerifyMethod.textContent = data.method || "GET";
      apiVerifyEndpoint.textContent = data.endpoint || url;
      apiVerifyCost.textContent = data.costType === "variable" ? "Variable" : (data.cost + " sats");
      apiVerifyDescription.textContent = data.description || "No description available";
      apiEditDescription.value = data.description || "";
      openApiModal();
    } catch (error) {
      alert(error.message || "Could not verify endpoint. Make sure it returns HTTP 402 with L402 headers.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit";
    }
  } else {
    // App flow
    try {
      var response = await fetch("/api/metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url }),
      });
      if (!response.ok) throw new Error("Unable to read metadata.");
      var metadata = await response.json();
    pendingApp = metadata;
    updateConfirmationFields(metadata);
    openModal();
  } catch (error) {
    alert("We could not fetch metadata for that URL. Please try again.");
  } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit";
    }
  }
});

confirmForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  var payload = {
    name: confirmName.value.trim(),
    url: confirmUrl.value.trim(),
    description: confirmDescription.value.trim(),
    image: confirmImage.value.trim(),
    icon: confirmIcon.value.trim(),
  };

  setStatus("Saving submission...");
  saveBtn.disabled = true;
  saveBtn.textContent = "Processing...";

  try {
    var response = await fetch("/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.status === 402) {
      var payData = await response.json();
      saveBtn.disabled = false;
      saveBtn.textContent = "Save and publish";
      confirmStatus.textContent = "";
      startPaymentFlow(payData);
      return;
    }
    if (response.status === 409) {
      var errData = await response.json();
      throw new Error(errData.error || "This app is already listed.");
    }
    if (!response.ok) {
      var message = await response.text();
      throw new Error(message || "Save failed.");
    }
    var newApp = await response.json();
    appsData.unshift(newApp);
    renderApps(appsData);
    closeModal();
    submissionForm.reset();
    pendingApp = null;
  } catch (error) {
    setStatus(error.message || "Could not save. Please try again.", true);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save and publish";
  }
});

apiConfirmForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  if (!pendingApiVerification) return;

  var invoice = apiInvoiceInput.value.trim();
  var description = apiEditDescription.value.trim();

  if (!invoice) {
    if (apiConfirmStatus) {
      apiConfirmStatus.textContent = "Please paste a 10 sat Lightning invoice.";
      apiConfirmStatus.style.color = "#f8b4ff";
    }
    return;
  }

  apiSaveBtn.disabled = true;
  apiSaveBtn.textContent = "Submitting...";
  if (apiConfirmStatus) {
    apiConfirmStatus.textContent = "Verifying and paying...";
    apiConfirmStatus.style.color = "var(--muted)";
  }

  try {
    var response = await fetch("/api/api-submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: pendingApiVerification.endpoint,
        invoice: invoice,
        description: description,
      }),
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || "Submission failed.");

    apisData.push(data);
    renderApis(apisData);
    closeApiModal();
    apiSubmissionForm.reset();
    alert("API submitted! 10 sats have been sent to your invoice.");
  } catch (error) {
    if (apiConfirmStatus) {
      apiConfirmStatus.textContent = error.message;
      apiConfirmStatus.style.color = "#f8b4ff";
    }
  } finally {
    apiSaveBtn.disabled = false;
    apiSaveBtn.textContent = "Submit & Earn 10 sats";
  }
});

/* -- L402 Status (for paywall note) -- */
var checkL402Status = async function () {
  try {
    var res = await fetch("/api/l402/status");
    var data = await res.json();
    l402Enabled = data.enabled;
    if (l402Enabled && paywallNote) {
      paywallNote.textContent = " Submission costs " + data.appSubmissionCostSats + " sats via Lightning.";
    }
  } catch (_err) {}
};

/* -- Init -- */
checkL402Status();
renderApps(appsData);
renderApis(apisData);
