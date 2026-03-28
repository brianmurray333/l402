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

var placeholderGradients = [
  ["#1a1a2e", "#16213e", "#0f3460"],
  ["#1b1b2f", "#162447", "#1f4068"],
  ["#0d1117", "#161b22", "#21262d"],
  ["#1a1423", "#2d1b69", "#11998e"],
  ["#0f0c29", "#302b63", "#24243e"],
  ["#1c1c3c", "#2a0845", "#6441a5"],
  ["#0c0c1d", "#1a2a6c", "#b21f1f"],
  ["#141e30", "#243b55", "#2c5364"],
];

var hashStr = function (s) {
  for (var h = 0, i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

var buildPlaceholder = function (name) {
  var el = document.createElement("div");
  el.className = "tile-placeholder";
  var idx = hashStr(name || "") % placeholderGradients.length;
  var g = placeholderGradients[idx];
  el.style.background = "linear-gradient(135deg, " + g[0] + ", " + g[1] + ", " + g[2] + ")";
  var letter = document.createElement("span");
  letter.className = "tile-placeholder-letter";
  letter.textContent = (name || "?").charAt(0).toUpperCase();
  el.appendChild(letter);
  return el;
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

var createTile = function (app) {
  var tile = document.createElement("div");
  tile.className = "app-tile" + (app.boost ? " app-tile--boosted" : "");
  tile.setAttribute("role", "button");
  tile.setAttribute("tabindex", "0");
  tile.setAttribute("aria-label", app.name);

  tile.appendChild(buildPlaceholder(app.name));
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
  tile.appendChild(nameLabel);

  tile.addEventListener("click", function () {
    openAppDetailModal(app);
  });

  return tile;
};

var renderApps = function (apps) {
  tileGrid.innerHTML = "";
  apps.forEach(function (app) { tileGrid.appendChild(createTile(app)); });

  var addTile = document.createElement("div");
  addTile.className = "app-tile add-tile";
  addTile.setAttribute("role", "button");
  addTile.setAttribute("tabindex", "0");
  addTile.setAttribute("aria-label", "Submit an app");
  addTile.innerHTML = '<div class="add-tile-inner"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg><span>Submit</span></div>';
  addTile.addEventListener("click", openSubmitModal);
  tileGrid.appendChild(addTile);

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
  confirmStatus.style.color = isError ? "#ff453a" : "var(--muted)";
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
var apiSearchInput = document.querySelector("[data-api-search]");
var apiFilterContainer = document.querySelector("[data-api-filters]");
var activeDirectionFilter = "all";
var selectedProviders = {};

var uprankIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';

var createApiCard = function (api) {
  var card = document.createElement("div");
  var cls = "api-card";
  if (api.boost) cls += " api-card--boosted";
  card.className = cls;

  var header = document.createElement("div");
  header.className = "api-card-header";
  var headerLeft = document.createElement("div");
  headerLeft.className = "api-card-header-left";

  if (api.icon) {
    var ic = document.createElement("img");
    ic.src = api.icon;
    ic.alt = "";
    ic.loading = "lazy";
    ic.className = "api-card-icon";
    ic.onerror = function () {
      var fallback = document.createElement("span");
      fallback.className = "api-card-icon-fallback";
      fallback.textContent = ((api.provider || api.name || "?").charAt(0)).toUpperCase();
      this.parentNode.replaceChild(fallback, this);
    };
    headerLeft.appendChild(ic);
  } else {
    var fallback = document.createElement("span");
    fallback.className = "api-card-icon-fallback";
    fallback.textContent = ((api.provider || api.name || "?").charAt(0)).toUpperCase();
    headerLeft.appendChild(fallback);
  }

  var providerName = document.createElement("span");
  providerName.className = "api-card-provider";
  providerName.textContent = api.provider || api.name;
  headerLeft.appendChild(providerName);

  var uprankBtn = document.createElement("button");
  uprankBtn.className = "api-uprank";
  uprankBtn.title = "Uprank this endpoint";
  uprankBtn.innerHTML = uprankIconSvg;
  uprankBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    startBoostFlow(api.id, "api", (api.provider || api.name) + " - " + api.name);
  });
  headerLeft.appendChild(uprankBtn);

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

  var desc = document.createElement("p");
  desc.className = "api-card-desc";
  desc.textContent = api.description || api.name || "";
  card.appendChild(desc);
  card.appendChild(endpointRow);

  return card;
};

var getFilteredApis = function () {
  var search = apiSearchInput ? apiSearchInput.value.toLowerCase().trim() : "";
  var hasProviderFilter = Object.keys(selectedProviders).length > 0;
  return apisData.filter(function (api) {
    if (activeDirectionFilter === "charges" && api.direction === "pays") return false;
    if (activeDirectionFilter === "pays" && api.direction !== "pays") return false;
    if (hasProviderFilter) {
      var provider = (api.provider || api.name || "").toLowerCase();
      if (!selectedProviders[provider]) return false;
    }
    if (search) {
      var text = [api.provider, api.name, api.description, api.endpoint, api.method].join(" ").toLowerCase();
      if (text.indexOf(search) === -1) return false;
    }
    return true;
  });
};

var renderApiFilters = function () {
  if (!apiFilterContainer) return;
  apiFilterContainer.innerHTML = "";

  var directionFilters = [
    { key: "all", label: "All" },
    { key: "charges", label: "Charges" },
    { key: "pays", label: "Pays" }
  ];

  directionFilters.forEach(function (f) {
    var pill = document.createElement("button");
    pill.className = "api-filter-pill" + (activeDirectionFilter === f.key ? " active" : "");
    pill.textContent = f.label;
    pill.addEventListener("click", function () {
      activeDirectionFilter = f.key;
      renderApiFilters();
      renderApis(getFilteredApis());
    });
    apiFilterContainer.appendChild(pill);
  });

  var providers = [];
  var seen = {};
  apisData.forEach(function (api) {
    var p = api.provider || api.name || "";
    var key = p.toLowerCase();
    if (!seen[key] && p) {
      seen[key] = true;
      providers.push({ key: key, label: p });
    }
  });

  if (providers.length > 0) {
    var dropdownWrap = document.createElement("div");
    dropdownWrap.className = "api-filter-dropdown-wrap";

    var selectedCount = Object.keys(selectedProviders).length;
    var appsPill = document.createElement("button");
    appsPill.className = "api-filter-pill" + (selectedCount > 0 ? " active" : "");
    appsPill.textContent = selectedCount > 0 ? "Apps (" + selectedCount + ") \u25BE" : "Apps \u25BE";

    var dropdown = document.createElement("div");
    dropdown.className = "api-filter-dropdown";

    providers.forEach(function (p) {
      var lbl = document.createElement("label");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!selectedProviders[p.key];
      cb.addEventListener("change", function (e) {
        e.stopPropagation();
        if (cb.checked) {
          selectedProviders[p.key] = true;
        } else {
          delete selectedProviders[p.key];
        }
        renderApiFilters();
        renderApis(getFilteredApis());
      });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(" " + p.label));
      lbl.addEventListener("click", function (e) { e.stopPropagation(); });
      dropdown.appendChild(lbl);
    });

    appsPill.addEventListener("click", function (e) {
      e.stopPropagation();
      dropdown.classList.toggle("is-open");
    });

    dropdownWrap.append(appsPill, dropdown);
    apiFilterContainer.appendChild(dropdownWrap);
  }
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

/* -- Submit Modal -- */
var submitModal = document.querySelector("#submit-modal");

var openSubmitModal = function () {
  submitModal.classList.add("is-open");
  submitModal.setAttribute("aria-hidden", "false");
  var urlInput = document.querySelector("#submit-url");
  if (urlInput) setTimeout(function () { urlInput.focus(); }, 100);
};

var closeSubmitModal = function () {
  submitModal.classList.remove("is-open");
  submitModal.setAttribute("aria-hidden", "true");
};

document.querySelectorAll("[data-submit-modal-close]").forEach(function (btn) {
  btn.addEventListener("click", closeSubmitModal);
});
submitModal.addEventListener("click", function (e) {
  if (e.target === submitModal) closeSubmitModal();
});

document.querySelectorAll("[data-open-submit]").forEach(function (link) {
  link.addEventListener("click", function (e) {
    e.preventDefault();
    openSubmitModal();
  });
});

document.addEventListener("click", function () {
  var openDropdown = document.querySelector(".api-filter-dropdown.is-open");
  if (openDropdown) openDropdown.classList.remove("is-open");
});

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
    if (submitModal.classList.contains("is-open")) closeSubmitModal();
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
      var confirmTitle = document.querySelector("#api-confirm-title");
      if (confirmTitle) {
        confirmTitle.textContent = "✓ Verified L402 Endpoint";
      }
      apiVerifyProvider.textContent = data.provider || "Unknown";
      apiVerifyMethod.textContent = data.method || "GET";
      apiVerifyEndpoint.textContent = data.endpoint || url;
      apiVerifyCost.textContent = data.cost ? (data.cost + " sats") : "Set by provider";
      apiVerifyDescription.textContent = data.description || "No description available";
      apiEditDescription.value = data.description || "";
      if (!data.description) apiEditDescription.setAttribute("required", "");
      else apiEditDescription.removeAttribute("required");
      closeSubmitModal();
      openApiModal();
    } catch (error) {
      alert(error.message || "Could not verify endpoint. It must return HTTP 402 with a valid L402 challenge (WWW-Authenticate header with macaroon+invoice, or lnbc invoice in response body).");
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
    closeSubmitModal();
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

  var paymentInput = apiInvoiceInput.value.trim();
  var description = apiEditDescription.value.trim();

  if (!paymentInput) {
    if (apiConfirmStatus) {
      apiConfirmStatus.textContent = "Please paste a Lightning invoice or address.";
      apiConfirmStatus.style.color = "#ff453a";
    }
    return;
  }

  var isLightningAddress = paymentInput.includes("@") && !paymentInput.startsWith("lnbc");
  var payload = { url: pendingApiVerification.endpoint, description: description };
  if (isLightningAddress) {
    payload.lightningAddress = paymentInput;
  } else {
    payload.invoice = paymentInput;
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
      body: JSON.stringify(payload),
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || "Submission failed.");

    apisData.push(data);
    renderApis(apisData);
    closeApiModal();
    apiSubmissionForm.reset();
    alert("API submitted! Your sats reward has been sent.");
  } catch (error) {
    if (apiConfirmStatus) {
      apiConfirmStatus.textContent = error.message;
      apiConfirmStatus.style.color = "#ff453a";
    }
  } finally {
    apiSaveBtn.disabled = false;
    apiSaveBtn.textContent = "Submit & Earn " + apiRewardSats + " sats";
  }
});

/* -- L402 Status (for paywall note) -- */
var apiRewardSats = 100;

var checkL402Status = async function () {
  try {
    var res = await fetch("/api/l402/status");
    var data = await res.json();
    l402Enabled = data.enabled;
    if (data.apiSubmissionRewardSats) apiRewardSats = data.apiSubmissionRewardSats;
    if (l402Enabled && paywallNote) {
      paywallNote.textContent = " Submission costs " + data.appSubmissionCostSats + " sats via Lightning.";
    }
    if (apiSaveBtn) apiSaveBtn.textContent = "Submit & Earn " + apiRewardSats + " sats";
  } catch (_err) {}
};

/* -- Mobile Tabs -- */
var mobileTabs = document.querySelectorAll("[data-tab]");
var apisSection = document.querySelector(".apis-section");
var appsSection = document.querySelector(".apps-section");
var isMobile = function () { return window.matchMedia("(max-width: 900px)").matches; };

var setMobileTab = function (tab) {
  mobileTabs.forEach(function (btn) {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
  });
  if (isMobile()) {
    apisSection.classList.toggle("mobile-hidden", tab !== "apis");
    appsSection.classList.toggle("mobile-hidden", tab !== "apps");
  }
};

mobileTabs.forEach(function (btn) {
  btn.addEventListener("click", function () {
    setMobileTab(btn.getAttribute("data-tab"));
  });
});

window.addEventListener("resize", function () {
  if (!isMobile()) {
    apisSection.classList.remove("mobile-hidden");
    appsSection.classList.remove("mobile-hidden");
  } else {
    var activeTab = document.querySelector(".mobile-tab.active");
    if (activeTab) setMobileTab(activeTab.getAttribute("data-tab"));
  }
});

/* -- Init -- */
if (apiSearchInput) {
  apiSearchInput.addEventListener("input", function () {
    renderApis(getFilteredApis());
  });
}

if (isMobile()) setMobileTab("apis");

checkL402Status();
renderApps(appsData);
renderApiFilters();
renderApis(apisData);
