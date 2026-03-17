(function () {
  "use strict";

  var blocks = window.__PIXEL_BLOCKS__ || [];
  var stats = window.__PIXEL_STATS__ || { totalPixels: 0, totalSats: 0, blockCount: 0, leaderboard: [] };

  var GRID = 1000;
  var dpr = window.devicePixelRatio || 1;
  var canvas = document.getElementById("grid-canvas");
  canvas.width = GRID * dpr;
  canvas.height = GRID * dpr;
  var ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  var gridWrap = document.getElementById("grid-wrap");
  var selBox = document.getElementById("selection-box");
  var tooltip = document.getElementById("tooltip");
  var tooltipTitle = document.getElementById("tooltip-title");
  var tooltipMeta = document.getElementById("tooltip-meta");

  var pixelsSold = document.getElementById("pixels-sold");
  var satsRaised = document.getElementById("sats-raised");
  var blockCount = document.getElementById("block-count");
  var leaderboard = document.getElementById("leaderboard");
  var recentList = document.getElementById("recent-list");

  var modal = document.getElementById("px-modal");
  var modalClose = document.getElementById("px-modal-close");
  var formStep = document.getElementById("px-form-step");
  var paymentStep = document.getElementById("px-payment-step");
  var confirmedStep = document.getElementById("px-confirmed-step");
  var buyBtn = document.getElementById("buy-pixels-btn");

  var pxX = document.getElementById("px-x");
  var pxY = document.getElementById("px-y");
  var pxW = document.getElementById("px-w");
  var pxH = document.getElementById("px-h");
  var pxColor = document.getElementById("px-color");
  var pxColorHex = document.getElementById("px-color-hex");
  var pxLink = document.getElementById("px-link");
  var pxTitle = document.getElementById("px-title");
  var pxCost = document.getElementById("px-cost");
  var pxPixelCount = document.getElementById("px-pixel-count");
  var pxGetInvoice = document.getElementById("px-get-invoice");
  var pxFormStatus = document.getElementById("px-form-status");

  var pxQr = document.getElementById("px-qr");
  var pxInvoiceText = document.getElementById("px-invoice-text");
  var pxCopyBtn = document.getElementById("px-copy-btn");
  var pxPaymentStatus = document.getElementById("px-payment-status");
  var pxConfirmedMsg = document.getElementById("px-confirmed-msg");

  var pollInterval = null;
  var pendingMacaroon = null;
  var pendingPaymentHash = null;

  // Selection state
  var isDragging = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var selectionRect = null;

  function formatNum(n) {
    return Number(n || 0).toLocaleString();
  }

  // ── Render grid on canvas ──
  function drawGrid() {
    ctx.fillStyle = "#0a0e17";
    ctx.fillRect(0, 0, GRID, GRID);

    // Draw faint grid lines every 100px
    ctx.strokeStyle = "rgba(255,255,255,0.03)";
    ctx.lineWidth = 0.5;
    for (var i = 0; i <= GRID; i += 100) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, GRID);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(GRID, i);
      ctx.stroke();
    }

    for (var j = 0; j < blocks.length; j++) {
      var b = blocks[j];
      if (b.imageData) {
        var img = new Image();
        img.onload = (function (block) {
          return function () {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(this, block.x, block.y, block.width, block.height);
          };
        })(b);
        img.src = b.imageData;
      } else {
        ctx.fillStyle = b.color || "#ff9900";
        ctx.fillRect(b.x, b.y, b.width, b.height);
      }
    }
  }

  // ── Pixel coord from mouse event ──
  function getGridCoords(e) {
    var rect = gridWrap.getBoundingClientRect();
    var scaleX = GRID / rect.width;
    var scaleY = GRID / rect.height;
    return {
      x: Math.floor((e.clientX - rect.left) * scaleX),
      y: Math.floor((e.clientY - rect.top) * scaleY),
    };
  }

  // ── Find block at pixel ──
  function blockAtPixel(px, py) {
    for (var i = blocks.length - 1; i >= 0; i--) {
      var b = blocks[i];
      if (px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height) {
        return b;
      }
    }
    return null;
  }

  // ── Selection dragging ──
  gridWrap.addEventListener("mousedown", function (e) {
    if (e.button !== 0) return;
    var coords = getGridCoords(e);
    isDragging = true;
    dragStartX = coords.x;
    dragStartY = coords.y;
    selectionRect = null;
    selBox.style.display = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", function (e) {
    var coords = getGridCoords(e);

    if (isDragging) {
      var x1 = Math.min(dragStartX, coords.x);
      var y1 = Math.min(dragStartY, coords.y);
      var x2 = Math.max(dragStartX, coords.x);
      var y2 = Math.max(dragStartY, coords.y);

      var w = Math.max(1, x2 - x1 + 1);
      var h = Math.max(1, y2 - y1 + 1);

      x1 = Math.max(0, Math.min(x1, GRID - 1));
      y1 = Math.max(0, Math.min(y1, GRID - 1));
      w = Math.min(w, GRID - x1);
      h = Math.min(h, GRID - y1);

      selectionRect = { x: x1, y: y1, w: w, h: h };

      var wrapRect = gridWrap.getBoundingClientRect();
      var sx = wrapRect.width / GRID;
      var sy = wrapRect.height / GRID;
      selBox.style.display = "block";
      selBox.style.left = (x1 * sx) + "px";
      selBox.style.top = (y1 * sy) + "px";
      selBox.style.width = (w * sx) + "px";
      selBox.style.height = (h * sy) + "px";
      return;
    }

    // Tooltip on hover
    if (coords.x >= 0 && coords.x < GRID && coords.y >= 0 && coords.y < GRID) {
      var block = blockAtPixel(coords.x, coords.y);
      if (block) {
        tooltipTitle.textContent = block.title || "Anonymous";
        tooltipMeta.textContent = (block.width * block.height) + " pixels · " + formatNum(block.amountSats) + " sats";
        if (block.link) {
          tooltipMeta.textContent += " · " + block.link.replace(/^https?:\/\//, "").slice(0, 40);
        }
        var wRect = gridWrap.getBoundingClientRect();
        var tipX = e.clientX - wRect.left + 14;
        var tipY = e.clientY - wRect.top + 14;
        if (tipX + 200 > wRect.width) tipX = e.clientX - wRect.left - 200;
        tooltip.style.display = "block";
        tooltip.style.left = tipX + "px";
        tooltip.style.top = tipY + "px";
      } else {
        tooltip.style.display = "none";
      }
    }
  });

  document.addEventListener("mouseup", function () {
    if (!isDragging) return;
    isDragging = false;
    if (selectionRect && selectionRect.w >= 1 && selectionRect.h >= 1) {
      pxX.value = selectionRect.x;
      pxY.value = selectionRect.y;
      pxW.value = selectionRect.w;
      pxH.value = selectionRect.h;
      updateCost();
      openModal();
    }
  });

  // Click on grid block opens its link
  gridWrap.addEventListener("click", function (e) {
    if (selectionRect && (selectionRect.w > 2 || selectionRect.h > 2)) return;
    var coords = getGridCoords(e);
    var block = blockAtPixel(coords.x, coords.y);
    if (block && block.link) {
      window.open(block.link, "_blank", "noopener");
    }
  });

  gridWrap.addEventListener("mouseleave", function () {
    tooltip.style.display = "none";
  });

  // ── Stats rendering ──
  function renderStats() {
    pixelsSold.textContent = formatNum(stats.totalPixels);
    satsRaised.textContent = formatNum(stats.totalSats);
    blockCount.textContent = formatNum(stats.blockCount);
  }

  function renderLeaderboard() {
    if (!stats.leaderboard || stats.leaderboard.length === 0) {
      leaderboard.innerHTML = '<div class="million-empty">No pixels purchased yet. Be the first!</div>';
      return;
    }
    leaderboard.innerHTML = stats.leaderboard.map(function (l, i) {
      return '<div class="million-leader-row">' +
        '<span><span class="leader-rank">#' + (i + 1) + '</span>' +
        '<span class="leader-name">' + escHtml(l.name) + '</span></span>' +
        '<span class="leader-pixels">' + formatNum(l.pixels) + ' px</span>' +
        '</div>';
    }).join("");
  }

  function renderRecent() {
    if (!blocks || blocks.length === 0) {
      recentList.innerHTML = '<div class="million-empty">No purchases yet.</div>';
      return;
    }
    var sorted = blocks.slice().reverse().slice(0, 15);
    recentList.innerHTML = sorted.map(function (b) {
      return '<div class="million-recent-row">' +
        '<div class="recent-block-info">' +
        '<div class="recent-color-swatch" style="background:' + escHtml(b.color || "#ff9900") + '"></div>' +
        '<div><div class="recent-block-title">' + escHtml(b.title || "Anonymous") + '</div>' +
        '<div class="recent-block-meta">' + b.width + 'x' + b.height + ' at (' + b.x + ',' + b.y + ')</div></div>' +
        '</div>' +
        '<span class="recent-block-sats">' + formatNum(b.amountSats) + ' sats</span>' +
        '</div>';
    }).join("");
  }

  function escHtml(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Cost update ──
  function updateCost() {
    var w = Math.max(1, parseInt(pxW.value || 1, 10));
    var h = Math.max(1, parseInt(pxH.value || 1, 10));
    var total = w * h;
    pxCost.textContent = formatNum(total);
    pxPixelCount.textContent = formatNum(total);
  }

  pxW.addEventListener("input", updateCost);
  pxH.addEventListener("input", updateCost);
  pxX.addEventListener("input", updateCost);
  pxY.addEventListener("input", updateCost);

  // Color sync
  pxColor.addEventListener("input", function () {
    pxColorHex.value = pxColor.value;
  });
  pxColorHex.addEventListener("input", function () {
    if (/^#[0-9a-fA-F]{6}$/.test(pxColorHex.value)) {
      pxColor.value = pxColorHex.value;
    }
  });

  // ── Modal ──
  function openModal() {
    formStep.style.display = "";
    paymentStep.classList.remove("is-active");
    confirmedStep.classList.remove("is-active");
    pxFormStatus.textContent = "";
    pxFormStatus.className = "px-status";
    pxGetInvoice.disabled = false;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    updateCost();
  }

  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    selBox.style.display = "none";
    selectionRect = null;
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  buyBtn.addEventListener("click", function () {
    pxX.value = 0;
    pxY.value = 0;
    pxW.value = 10;
    pxH.value = 10;
    updateCost();
    openModal();
  });
  modalClose.addEventListener("click", closeModal);

  var modalMouseDownTarget = null;
  modal.addEventListener("mousedown", function (e) { modalMouseDownTarget = e.target; });
  modal.addEventListener("click", function (e) {
    if (e.target === modal && modalMouseDownTarget === modal) closeModal();
    modalMouseDownTarget = null;
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && modal.classList.contains("is-open")) closeModal();
  });

  // ── Buy flow ──
  pxGetInvoice.addEventListener("click", function () {
    var x = parseInt(pxX.value, 10);
    var y = parseInt(pxY.value, 10);
    var w = parseInt(pxW.value, 10);
    var h = parseInt(pxH.value, 10);

    if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) {
      pxFormStatus.textContent = "All coordinates must be numbers.";
      pxFormStatus.className = "px-status px-status--error";
      return;
    }
    if (x < 0 || y < 0 || x + w > GRID || y + h > GRID) {
      pxFormStatus.textContent = "Selection is out of bounds (0–999).";
      pxFormStatus.className = "px-status px-status--error";
      return;
    }
    if (w < 1 || h < 1) {
      pxFormStatus.textContent = "Width and height must be at least 1.";
      pxFormStatus.className = "px-status px-status--error";
      return;
    }
    if (w * h > 10000) {
      pxFormStatus.textContent = "Maximum 10,000 pixels per purchase.";
      pxFormStatus.className = "px-status px-status--error";
      return;
    }

    pxGetInvoice.disabled = true;
    pxFormStatus.textContent = "Checking availability...";
    pxFormStatus.className = "px-status";

    var body = {
      x: x, y: y, width: w, height: h,
      color: pxColorHex.value || "#ff9900",
      link: pxLink.value.trim() || undefined,
      title: pxTitle.value.trim() || undefined,
    };

    fetch("/api/million/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().then(function (data) { return { status: r.status, data: data }; });
      })
      .then(function (result) {
        if (result.status === 402 && result.data.invoice) {
          pendingMacaroon = result.data.macaroon;
          pendingPaymentHash = result.data.paymentHash;

          if (result.data.qrCode) {
            pxQr.src = result.data.qrCode;
          } else {
            pxQr.src = "/api/l402/qr/" + result.data.paymentHash;
          }
          pxInvoiceText.value = result.data.invoice;
          pxPaymentStatus.textContent = "Waiting for payment...";
          pxPaymentStatus.className = "px-status";

          formStep.style.display = "none";
          paymentStep.classList.add("is-active");
          startPaymentPolling(body);
        } else if (result.data.error) {
          pxFormStatus.textContent = result.data.error;
          pxFormStatus.className = "px-status px-status--error";
          pxGetInvoice.disabled = false;
        } else {
          pxFormStatus.textContent = "Unexpected response.";
          pxFormStatus.className = "px-status px-status--error";
          pxGetInvoice.disabled = false;
        }
      })
      .catch(function (err) {
        pxFormStatus.textContent = "Network error: " + err.message;
        pxFormStatus.className = "px-status px-status--error";
        pxGetInvoice.disabled = false;
      });
  });

  // ── Copy Invoice ──
  pxCopyBtn.addEventListener("click", function () {
    navigator.clipboard.writeText(pxInvoiceText.value).then(function () {
      pxCopyBtn.textContent = "Copied!";
      setTimeout(function () { pxCopyBtn.textContent = "Copy"; }, 2000);
    }).catch(function () {});
  });

  // ── Payment polling ──
  function startPaymentPolling(buyBody) {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(function () {
      fetch("/api/l402/check/" + pendingPaymentHash)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.paid) {
            clearInterval(pollInterval);
            pollInterval = null;
            pxPaymentStatus.textContent = "Payment received! Claiming pixels...";
            pxPaymentStatus.className = "px-status px-status--success";

            var token = pendingMacaroon + ":" + data.preimage;
            return fetch("/api/million/buy", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": "L402 " + token,
              },
              body: JSON.stringify(buyBody),
            })
              .then(function (r2) { return r2.json(); })
              .then(function (result) {
                if (result.success) {
                  blocks.push(result.block);
                  stats = result.stats;
                  drawGrid();
                  renderStats();
                  renderLeaderboard();
                  renderRecent();

                  paymentStep.classList.remove("is-active");
                  confirmedStep.classList.add("is-active");
                  var px = result.block.width * result.block.height;
                  pxConfirmedMsg.textContent =
                    px + " pixel" + (px === 1 ? "" : "s") + " claimed at (" +
                    result.block.x + "," + result.block.y + ") for " +
                    formatNum(result.block.amountSats) + " sats. Thank you for supporting OpenSats!";
                } else {
                  pxPaymentStatus.textContent = result.error || "Pixel claim failed.";
                  pxPaymentStatus.className = "px-status px-status--error";
                }
              });
          }
        })
        .catch(function () {});
    }, 2500);
  }

  // ── Refresh data ──
  function refreshData() {
    fetch("/api/million/grid")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.length !== blocks.length) {
          blocks = data;
          drawGrid();
          renderRecent();
        }
      })
      .catch(function () {});

    fetch("/api/million/stats")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.totalPixels !== stats.totalPixels || data.blockCount !== stats.blockCount) {
          stats = data;
          renderStats();
          renderLeaderboard();
        }
      })
      .catch(function () {});
  }

  // ── Init ──
  drawGrid();
  renderStats();
  renderLeaderboard();
  renderRecent();

  setInterval(refreshData, 5000);
})();
