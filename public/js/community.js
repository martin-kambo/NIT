// community.js — Phase 4B.25A extraction
// Community-specific JavaScript: Notice Board, Ad Requests, Ask AI.
// Extracted from public/index.html (Phase 4B.25A).
// Depends on globals in index.html: apiCall, currentUser, showToast,
// addNotification, renderNotifBell, initScrollReveal, window.currentPeriodEnd

// ─────────────────────────────────────────────────────────────
// NOTICE BOARD
// ─────────────────────────────────────────────────────────────
// ══ NOTICEBOARD — Live API-driven ══
let activeNoticeFilter = "all";
let _noticeCache = [];

const NOTICE_EMOJI = {
  business: "🛒", event: "🎉", public: "📢", jobs: "💼", general: "📌"
};

async function renderNoticeboardTab() {
  // Wire filter buttons
  document.querySelectorAll(".notice-filter").forEach(btn => {
    btn.onclick = () => {
      activeNoticeFilter = btn.dataset.nf;
      document.querySelectorAll(".notice-filter").forEach(b =>
        b.classList.toggle("active", b.dataset.nf === activeNoticeFilter));
      buildNotices(_noticeCache);
    };
  });

  const grid = document.getElementById("noticesGrid");
  if (grid) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:2rem;color:var(--mid-gray)"><i class="fas fa-spinner fa-spin"></i>&nbsp; Loading notices...</div>';

  try {
    const res = await fetch('/api/notices');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.success) {
      _noticeCache = data.notices;
      buildNotices(_noticeCache);
    } else {
      throw new Error(data.error || 'Unknown error');
    }
  } catch (err) {
    console.error('Noticeboard fetch error:', err);
    if (grid) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:2rem;color:var(--mid-gray)">⚠️ Could not load notices. Please refresh.</div>';
  }
}

function buildNotices(notices) {
  const grid  = document.getElementById("noticesGrid");
  const empty = document.getElementById("noticeEmpty");
  if (!grid) return;

  const filtered = activeNoticeFilter === "all"
    ? notices
    : notices.filter(n => n.category === activeNoticeFilter);

  if (!filtered.length) {
    grid.innerHTML = "";
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");

  const catMap = {
    business: { label: "Business",      cls: "ncat-business" },
    event:    { label: "Event",          cls: "ncat-event"    },
    public:   { label: "Public Notice",  cls: "ncat-public"   },
    jobs:     { label: "Jobs",           cls: "ncat-jobs"     },
    general:  { label: "General",        cls: ""              }
  };

  grid.innerHTML = filtered.map(n => {
    const cm       = catMap[n.category] || { label: n.category, cls: "" };
    const emoji    = NOTICE_EMOJI[n.category] || "📌";
    const isUrgent = n.priority === "high";
    const isAd     = !!n.is_ad;

    // Smart relative date
    let dateStr = "";
    if (n.created_at) {
      const ts   = new Date(n.created_at).getTime();
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      const hrs  = Math.floor(diff / 3600000);
      const days = Math.floor(diff / 86400000);
      if (diff < 60000)      dateStr = "Just now";
      else if (mins < 60)    dateStr = `${mins}m ago`;
      else if (hrs < 24)     dateStr = `${hrs}h ago`;
      else if (days === 1)   dateStr = "Yesterday";
      else if (days < 7)     dateStr = `${days}d ago`;
      else                   dateStr = new Date(n.created_at).toLocaleDateString("en-KE", { day:"numeric", month:"short" });
    }

    const author   = n.author || (isAd ? "Sponsored" : "Admin");
    const safeTitle = (n.title || "").replace(/'/g, "\'");
    const contactBtn = isAd && n.contact_phone
      ? `<a class="notice-cta-btn" href="tel:${n.contact_phone}" style="text-decoration:none">📞 Call</a>`
      : `<button class="notice-cta-btn" onclick="showToast('📌 ${safeTitle}','info')">More →</button>`;

    return `<div class="notice-card scroll-reveal${isAd ? ' notice-card--ad' : ''}">
      <div class="notice-card-top">
        <span style="font-size:0.85rem;line-height:1;margin-right:0.1rem">${emoji}</span>
        <span class="notice-cat-badge ${cm.cls}">${cm.label}</span>
        ${isAd ? '<span class="notice-sponsored">Ad</span>' : ""}
        ${isUrgent && !isAd ? '<span class="notice-sponsored" style="background:#e63946;color:#fff;border:none">⚠ Urgent</span>' : ""}
      </div>
      <div class="notice-card-body">
        <div class="notice-card-title">${n.title || ""}</div>
        <div class="notice-card-desc">${n.content || ""}</div>
      </div>
      <div class="notice-card-footer">
        <div class="notice-meta"><strong>${author}</strong> · ${dateStr}</div>
        ${contactBtn}
      </div>
    </div>`;
  }).join("");
  initScrollReveal(); // newly injected cards need the observer re-run on them
}


// ─────────────────────────────────────────────────────────────
// AD REQUESTS
// ─────────────────────────────────────────────────────────────
const AD_CHAT_KEY="ngoliba_ad_chat";
function getAdChat(){return JSON.parse(localStorage.getItem(AD_CHAT_KEY)||"[]");}
function saveAdChat(arr){localStorage.setItem(AD_CHAT_KEY,JSON.stringify(arr));}

function initAdRequestChat(){
  const openBtn=document.getElementById("openAdRequestBtn");
  const closeBtn=document.getElementById("closeAdRequestBtn");
  const panel=document.getElementById("adRequestPanel");
  if(!openBtn)return;
  openBtn.onclick=()=>{
    panel.classList.toggle("hidden");
    if(!panel.classList.contains("hidden")) {
      // Auto-switch to history if user has prior requests, otherwise stay on new
      switchAdPanel('new');
    }
  };
  closeBtn.onclick=()=>panel.classList.add("hidden");
}

// ── Panel tab switching ──
function switchAdPanel(tab) {
  const newPane     = document.getElementById('adFormState');
  const successPane = document.getElementById('adSuccessState');
  const payPane     = document.getElementById('adPayState');
  const histPane    = document.getElementById('adHistoryPane');
  const tabNew      = document.getElementById('adPanelTabNew');
  const tabHist     = document.getElementById('adPanelTabHistory');

  if (tab === 'history') {
    if (newPane)     newPane.style.display     = 'none';
    if (successPane) successPane.style.display = 'none';
    if (payPane)     payPane.style.display     = 'none';
    if (histPane)    histPane.style.display    = 'block';
    if (tabNew)  { tabNew.style.borderBottomColor  = 'transparent'; tabNew.style.color  = 'var(--mid-gray)'; }
    if (tabHist) { tabHist.style.borderBottomColor = 'var(--forest)'; tabHist.style.color = 'var(--forest)'; }
    loadMyAdRequests();
  } else {
    if (histPane) histPane.style.display = 'none';
    // Restore whichever new-request state was active
    const hasSuccess = lastAdRequestId && successPane?.innerHTML.trim();
    if (newPane && !lastAdRequestId)  newPane.style.display = 'block';
    if (successPane && lastAdRequestId) successPane.style.display = 'block';
    if (tabNew)  { tabNew.style.borderBottomColor  = 'var(--forest)'; tabNew.style.color  = 'var(--forest)'; }
    if (tabHist) { tabHist.style.borderBottomColor = 'transparent'; tabHist.style.color = 'var(--mid-gray)'; }
  }
}

// ── Load & render history ──
async function loadMyAdRequests() {
  const list = document.getElementById('adHistoryList');
  if (!list) return;
  list.innerHTML = '<div style="text-align:center;padding:2rem 0;color:var(--mid-gray);font-size:0.82rem;">⏳ Loading…</div>';
  try {
    const res  = await fetch('/api/my-ad-requests');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    renderAdHistory(data.adRequests, list);
  } catch (err) {
    list.innerHTML = `<div style="text-align:center;padding:1.5rem 0;color:var(--red-accent);font-size:0.8rem;">⚠️ ${err.message}</div>`;
  }
}

function renderAdHistory(requests, container) {
  if (!requests.length) {
    container.innerHTML = '<div style="text-align:center;padding:2rem 0;color:var(--mid-gray);font-size:0.82rem;">You have no ad requests yet.</div>';
    return;
  }

  const statusConfig = {
    pending:         { label: '⏳ Under Review',      bg: '#fff7ed', color: '#b45309' },
    payment_pending: { label: '💳 Payment Required',  bg: '#f5f3ff', color: '#7c3aed' },
    approved:        { label: '✅ Approved & Live',    bg: '#f0fdf4', color: '#15803d' },
    rejected:        { label: '❌ Not Approved',       bg: '#fef2f2', color: '#b91c1c' },
    completed:       { label: '🏁 Completed',          bg: '#eff6ff', color: '#1d4ed8' },
  };

  container.innerHTML = requests.map(r => {
    const s   = statusConfig[r.status] || { label: r.status, bg: '#f3f4f6', color: '#6b7280' };
    const dt  = new Date(r.submitted_at).toLocaleDateString('en-KE', { day:'numeric', month:'short', year:'numeric' });
    const isPayable = r.status === 'payment_pending';

    return `
    <div style="border:1px solid var(--sand);border-radius:0.75rem;padding:0.9rem;margin-bottom:0.75rem;background:white;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.5rem;margin-bottom:0.5rem;">
        <div style="font-weight:700;font-size:0.85rem;color:var(--text-dark);flex:1;">${r.business_name}</div>
        <span style="font-size:0.7rem;font-weight:700;padding:2px 8px;border-radius:50px;white-space:nowrap;background:${s.bg};color:${s.color};">${s.label}</span>
      </div>
      <div style="font-size:0.78rem;color:var(--mid-gray);margin-bottom:0.5rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${r.ad_content}</div>
      <div style="display:flex;gap:1rem;font-size:0.72rem;color:var(--mid-gray);flex-wrap:wrap;margin-bottom:${isPayable || r.notes ? '0.65rem' : '0'};">
        <span>⏱ ${r.duration}</span>
        <span>📅 ${dt}</span>
        ${r.fee ? `<span style="color:#7c3aed;font-weight:700;">KES ${r.fee.toLocaleString()}</span>` : ''}
      </div>
      ${r.notes ? `<div style="font-size:0.74rem;color:var(--text-mid);background:var(--cream-dark);border-radius:0.4rem;padding:0.4rem 0.6rem;margin-bottom:${isPayable ? '0.65rem' : '0'};">📝 ${r.notes}</div>` : ''}
      ${isPayable ? `
        <button onclick="openPayFromHistory('${r.id}', ${r.fee}, '${r.duration}')"
          style="width:100%;display:flex;align-items:center;justify-content:center;gap:0.4rem;background:linear-gradient(135deg,#00a550,#007a3a);color:white;border:none;border-radius:50px;padding:0.5rem;font-size:0.8rem;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;">
          📲 Pay KES ${r.fee.toLocaleString()} via M-Pesa
        </button>` : ''}
    </div>`;
  }).join('');
}

// Opens the pay pane from history tab (switching to new-request pane area)
function openPayFromHistory(id, fee, duration) {
  lastAdRequestId = id;
  // Switch to the "new" tab area to show the pay pane
  switchAdPanel('new');
  document.getElementById('adFormState').style.display     = 'none';
  document.getElementById('adSuccessState').style.display  = 'none';
  document.getElementById('adPayState').style.display      = 'block';
  document.getElementById('adPayAmount').textContent        = `KES ${fee.toLocaleString()}`;
  document.getElementById('adPayDuration').textContent      = `Duration: ${duration}`;
  document.getElementById('adAdminNotes').style.display     = 'none';
  if (currentUser?.phone) {
    const n = currentUser.phone.replace(/^0/, '').replace(/^254/, '').slice(0, 9);
    document.getElementById('adPayPhone').value = n;
  }
}

async function submitAdRequest(){
  const businessName = document.getElementById("arBusinessName").value.trim();
  const adContent    = document.getElementById("arAdContent").value.trim();
  const category     = document.getElementById("arCategory").value;
  const duration     = document.getElementById("arDuration").value;
  const contactPhone = document.getElementById("arContactPhone").value.trim();
  const contactEmail = document.getElementById("arContactEmail").value.trim();
  const errEl        = document.getElementById("arError");
  const btn          = document.getElementById("adRequestSendBtn");

  // Validate
  if (!businessName) { showArError("Please enter your business or organisation name."); return; }
  if (!adContent)    { showArError("Please describe what you'd like to advertise."); return; }
  if (!contactPhone) { showArError("Please enter a contact phone number."); return; }
  errEl.style.display = "none";

  // Loading state
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…';

  try {
    const res = await fetch('/api/ad-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessName, adContent, category, duration, contactPhone, contactEmail: contactEmail || undefined })
    });
    const data = await res.json();
    if (res.status === 401) {
      showArError('You must be logged in to submit an ad request. Please log in and try again.');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Request';
      return;
    }
    if (!data.success) throw new Error(data.error || 'Submission failed');

    // Remember ID so user can check status / pay later
    lastAdRequestId = data.id;

    // Show success state
    document.getElementById("adFormState").style.display    = "none";
    document.getElementById("adSuccessState").style.display = "block";
    addNotification({icon:"📣",iconCls:"ni-notice",text:"Your <strong>ad request</strong> was submitted. Admin will respond within 24 hours.",type:"notice"});

  } catch(err) {
    showArError("Failed to submit: " + err.message);
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Request';
  }
}

function showArError(msg){
  const el = document.getElementById("arError");
  el.textContent = msg;
  el.style.display = "block";
}

// Tracks the last submitted request ID so the user can check status
let lastAdRequestId = null;

async function checkAdRequestStatus() {
  if (!lastAdRequestId) return;
  try {
    const res  = await fetch(`/api/ad-requests/${lastAdRequestId}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    const r = data.adRequest;

    if (r.status === 'payment_pending') {
      // Switch to pay state
      document.getElementById('adSuccessState').style.display = 'none';
      document.getElementById('adPayState').style.display    = 'block';
      document.getElementById('adPayAmount').textContent     = `KES ${r.fee.toLocaleString()}`;
      document.getElementById('adPayDuration').textContent   = `Duration: ${r.duration}`;

      const notesEl = document.getElementById('adAdminNotes');
      if (r.notes) { notesEl.textContent = `📝 Admin note: ${r.notes}`; notesEl.style.display = 'block'; }

      // Pre-fill phone from profile if available
      if (currentUser?.phone) {
        const n = currentUser.phone.replace(/^0/, '').replace(/^254/, '').slice(0, 9);
        document.getElementById('adPayPhone').value = n;
      }
    } else if (r.status === 'approved') {
      showToast('🎉 Your ad has been approved and is now live!', 'success');
    } else if (r.status === 'rejected') {
      showToast('Your ad request was not approved. Please contact admin.', 'error');
    } else {
      showToast('⏳ Still under review — check back soon.', 'info');
    }
  } catch (err) {
    showToast('Could not check status: ' + err.message, 'error');
  }
}

async function initiateAdPayment() {
  const raw = document.getElementById('adPayPhone').value.trim();
  if (!/^\d{9}$/.test(raw)) {
    const el = document.getElementById('adPayError');
    el.textContent = 'Enter a valid 9-digit M-Pesa number e.g. 712 345 678';
    el.style.display = 'block';
    return;
  }
  document.getElementById('adPayError').style.display = 'none';

  const btn = document.getElementById('adPayBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="btn-spinner" style="width:16px;height:16px;border:2px solid rgba(255,255,255,0.4);border-top-color:white;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block;"></div> Sending STK Push…';

  const fullPhone = '254' + raw;
  try {
    // Reuse the existing DARAJA engine (simulated / real in production)
    await DARAJA.getAccessToken();
    const stk = await DARAJA.initiateStkPush({ phone: fullPhone, amount: parseInt(document.getElementById('adPayAmount').textContent.replace(/[^\d]/g, '')), accountRef: 'NGOLIBA-AD' });
    if (stk.ResponseCode !== '0') throw new Error(stk.ResponseDescription);

    // Simulate PIN confirmation (same pattern as voting flow)
    btn.innerHTML = '⏳ Waiting for M-Pesa PIN…';
    const result = await DARAJA.simulateIpnCallback(stk.CheckoutRequestID, true);

    if (result.ResultCode === 0) {
      // Confirm payment on the server
      const confirm = await fetch(`/api/ad-requests/${lastAdRequestId}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mpesaReceiptNumber: result.MpesaReceiptNumber, phone: fullPhone })
      });
      const confirmData = await confirm.json();
      if (!confirmData.success) throw new Error(confirmData.error);

      // Success UI
      document.getElementById('adPayState').style.display = 'none';
      document.getElementById('adSuccessState').style.display = 'block';
      document.getElementById('adSuccessState').innerHTML = `
        <div style="font-size:2.5rem;margin-bottom:0.75rem;">🎉</div>
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:1rem;color:var(--text-dark);margin-bottom:0.4rem;">Ad Submitted <span style="font-size:0.7rem;font-weight:500;color:var(--mid-gray);">(Preview)</span></div>
        <div style="font-size:0.82rem;color:var(--mid-gray);line-height:1.5;margin-bottom:0.75rem;">
          Simulated receipt: <strong>${result.MpesaReceiptNumber}</strong><br>Your ad is now <strong>live</strong>. <em>No real M-Pesa charge occurred.</em>
        </div>
        <button onclick="resetAdForm()" style="display:inline-flex;align-items:center;gap:0.4rem;background:var(--cream-dark);border:1px solid var(--sand);border-radius:50px;padding:0.45rem 1.2rem;font-size:0.78rem;font-weight:600;cursor:pointer;font-family:'Outfit',sans-serif;color:var(--text-mid);">
          Done
        </button>`;
      addNotification({ icon:'💳', iconCls:'ni-notice', text:`M-Pesa payment confirmed — your ad is now <strong>live</strong>! Receipt: ${result.MpesaReceiptNumber}`, type:'notice' });
      // Refresh history so the status updates
      loadMyAdRequests();
    } else {
      throw new Error(result.ResultDesc || 'Payment was not confirmed');
    }
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<span style="font-size:1rem;">📲</span> Pay via M-Pesa';
    const el = document.getElementById('adPayError');
    el.textContent = 'Payment failed: ' + err.message;
    el.style.display = 'block';
  }
}

function resetAdForm(){
  ["arBusinessName","arContactPhone","arContactEmail"].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value="";
  });
  const ta=document.getElementById("arAdContent"); if(ta) ta.value="";
  document.getElementById("adFormState").style.display    = "block";
  document.getElementById("adSuccessState").style.display = "none";
  document.getElementById("adPayState").style.display     = "none";
  document.getElementById("arError").style.display        = "none";
  const btn=document.getElementById("adRequestSendBtn");
  if(btn){ btn.disabled=false; btn.innerHTML='<i class="fas fa-paper-plane"></i> Submit Request'; }
  lastAdRequestId = null;
}

// ─────────────────────────────────────────────────────────────
// ASK AI
// ─────────────────────────────────────────────────────────────
async function handleAIAsk(){
  const input=document.getElementById("aiPromptInput").value.trim();
  if(!input){showToast("Enter a question first","error");return;}
  const responseEl=document.getElementById("aiResponse");
  responseEl.style.display="block";
  responseEl.innerHTML='<div class="ai-typing"><span></span><span></span><span></span></div>';
  document.getElementById("aiAskBtn").disabled=true;

  // Call the real Anthropic API
  try{
    const agg=getCurrentPeriodAggregated();
    const votesSummary=CANDIDATES.map(c=>`${c.name} (${c.party}): ${agg[c.id]?.total||0} votes`).join(", ");
    const users=DB.getUsers();
    const wardLabel  = (typeof currentUser!=='undefined'&&currentUser?.wardName)  || 'this ward';
    const countyLabel= (typeof currentUser!=='undefined'&&currentUser?.countyName) || 'Kenya';
    const subLabel   = SUBLOCATIONS.length>0 ? SUBLOCATIONS.join(', ') : 'various sublocations';
    const context=`You are the AI analyst for InfoTrack, a ward-level opinion poll platform in ${wardLabel}, ${countyLabel}. The poll tracks ${CANDIDATES.length} MCA candidates. Current cycle vote totals: ${votesSummary}. Total registered voters: ${users.length}. Sublocations: ${subLabel}. Answer the user's question concisely and insightfully in 2-4 sentences. Be specific to ${wardLabel} context.`;
    const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:300,system:context,messages:[{role:"user",content:input}]})});
    const data=await res.json();
    const reply=data.content?.[0]?.text||"I could not generate a response. Please try again.";
    responseEl.innerHTML=reply;
  }catch(e){
    // Fallback to local AI
    responseEl.innerHTML=generateLocalAIResponse(input);
  }
  document.getElementById("aiAskBtn").disabled=false;
}

function generateLocalAIResponse(query){
  // Phase 3B Polish: this fallback previously invented ward-specific
  // statistics, percentages, and candidate claims whenever the live AI
  // request failed. It no longer fabricates any data — it just tells the
  // user live analysis isn't available right now, regardless of what they
  // asked.
  return "Live AI analysis is currently unavailable. Please try again in a moment — in the meantime, the Leaderboard and Notice Board tabs have up-to-date information.";
}

function getTimeToReset(){
  if(!window.currentPeriodEnd) return "soon";
  const diff=new Date(window.currentPeriodEnd)-Date.now();
  if(diff<=0) return "now";
  const m=Math.floor(diff/60000), s=Math.floor((diff%60000)/1000);
  return `${m}m ${s}s`;
}
