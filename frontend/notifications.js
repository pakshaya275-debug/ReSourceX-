/* ReSourceX: notification centre and request messaging.
   Self-contained: it injects its own styles and talks to the same API as script.js.
   Works on every signed-in page (script.js is not required). */
(function () {
    "use strict";
    var TOKEN_KEY = "resourceXAuthToken";
    var API = window.RESOURCEX_API_URL;
    var POLL_MS = 30000, CHAT_POLL_MS = 8000;

    function token() { return localStorage.getItem(TOKEN_KEY); }
    function esc(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    function api(path, options) {
        options = options || {};
        var headers = { Authorization: "Bearer " + token() };
        if (options.body) headers["Content-Type"] = "application/json";
        return fetch(API + path, { method: options.method || "GET", headers: headers, body: options.body ? JSON.stringify(options.body) : undefined })
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (data) {
                    if (!res.ok) { var err = new Error(data.error || "Request failed (" + res.status + ")"); err.status = res.status; throw err; }
                    return data;
                });
            });
    }
    function timeAgo(iso) {
        var seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
        if (seconds < 60) return "just now";
        if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
        if (seconds < 86400) return Math.floor(seconds / 3600) + " h ago";
        return new Date(iso).toLocaleDateString();
    }

    var css = "\
    .rx-bell{position:fixed;top:auto;bottom:18px;right:18px;z-index:9000;width:44px;height:44px;border-radius:50%;border:1px solid #dce7e2;background:#fff;color:#087f5b;font-size:20px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.12)}\
    .rx-bell:hover{background:#e9f7f1}.rx-bell:focus-visible{outline:3px solid #0f9d82;outline-offset:2px}\
    .notification-btn{position:relative;display:inline-flex;align-items:center;justify-content:center}.notification-btn svg{width:20px;height:20px;display:block}.rx-header-badge{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#d6336c;color:#fff;font-size:11px;font-weight:700;align-items:center;justify-content:center}.rx-badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#d6336c;color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center}\
    .rx-panel{position:fixed;top:auto;bottom:72px;right:18px;z-index:9001;width:min(380px,calc(100vw - 24px));max-height:70vh;display:none;flex-direction:column;background:#fff;border:1px solid #dce7e2;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);font-family:Inter,'Segoe UI',sans-serif;color:#17221e}\
    .rx-panel.open{display:flex}\
    .rx-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #dce7e2;font-weight:700}\
    .rx-link{background:none;border:0;color:#087f5b;cursor:pointer;font-size:13px;font-weight:600}\
    .rx-list{overflow:auto;list-style:none;margin:0;padding:0}\
    .rx-item{padding:11px 14px;border-bottom:1px solid #eef3f1;cursor:pointer;font-size:14px;line-height:1.4}\
    .rx-item:hover{background:#f2fbf7}.rx-item.unread{background:#e9f7f1;font-weight:600}\
    .rx-item small{display:block;color:#7a8580;font-weight:400;margin-top:2px}\
    .rx-empty{padding:22px 14px;text-align:center;color:#7a8580;font-size:14px}\
    .rx-modal{position:fixed;inset:0;z-index:9100;background:rgba(23,34,30,.55);display:none;align-items:center;justify-content:center;padding:12px}\
    .rx-modal.open{display:flex}\
    .rx-chat{width:min(520px,100%);height:min(560px,90vh);background:#fff;border-radius:14px;display:flex;flex-direction:column;font-family:Inter,'Segoe UI',sans-serif;color:#17221e;overflow:hidden}\
    .rx-chat-body{flex:1;overflow:auto;padding:14px;background:#f2fbf7;display:flex;flex-direction:column;gap:8px}\
    .rx-msg{max-width:80%;padding:8px 11px;border-radius:12px;font-size:14px;line-height:1.4;background:#fff;border:1px solid #dce7e2;align-self:flex-start;word-wrap:break-word}\
    .rx-msg.mine{align-self:flex-end;background:#087f5b;color:#fff;border-color:#087f5b}\
    .rx-msg small{display:block;opacity:.75;font-size:11px;margin-bottom:2px}\
    .rx-chat-form{display:flex;gap:8px;padding:10px;border-top:1px solid #dce7e2}\
    .rx-chat-form input{flex:1;padding:10px 12px;border:1px solid #dce7e2;border-radius:8px;font-size:14px}\
    .rx-send{padding:0 16px;border:0;border-radius:8px;background:#087f5b;color:#fff;font-weight:700;cursor:pointer}.rx-send:disabled{opacity:.5}\
    .rx-error{color:#c92a2a;font-size:13px;padding:0 14px 8px}\
    .btn-chat{margin-left:6px;padding:6px 10px;border:1px solid #087f5b;border-radius:8px;background:#fff;color:#087f5b;font-weight:600;cursor:pointer}";

    var state = { notifications: [], unread: 0, pollTimer: null };
    var bell, badge, panel, list;

    function renderList() {
        badge.style.display = state.unread ? "block" : "none";
        badge.textContent = state.unread > 99 ? "99+" : String(state.unread);
        document.querySelectorAll(".notification-btn .rx-header-badge").forEach(function (el) {
            el.textContent = state.unread ? (state.unread > 99 ? "99+" : String(state.unread)) : "";
            el.style.display = state.unread ? "inline-flex" : "none";
        });
        bell.setAttribute("aria-label", "Notifications, " + state.unread + " unread");
        if (!state.notifications.length) { list.innerHTML = '<li class="rx-empty">You have no notifications yet.</li>'; return; }
        list.innerHTML = state.notifications.map(function (n) {
            return '<li class="rx-item ' + (n.isRead ? "" : "unread") + '" data-id="' + n.id + '" tabindex="0">' + esc(n.message) + "<small>" + esc(timeAgo(n.createdAt)) + "</small></li>";
        }).join("");
    }
    function refresh() {
        if (!token()) return Promise.resolve();
        return api("/notifications?limit=20").then(function (data) {
            state.notifications = data.notifications || []; state.unread = data.unreadCount || 0; renderList();
        }).catch(function (err) { if (err.status === 401) stopPolling(); });
    }
    function stopPolling() { if (state.pollTimer) clearInterval(state.pollTimer); state.pollTimer = null; }

    function openNotification(id) {
        var n = state.notifications.filter(function (x) { return String(x.id) === String(id); })[0];
        if (!n) return;
        var done = n.isRead ? Promise.resolve() : api("/notifications/" + n.id + "/read", { method: "PUT" }).catch(function () {});
        done.then(refresh);
        if (n.relatedType === "request" && n.relatedId) { panel.classList.remove("open"); openChat(n.relatedId); }
        else if (n.relatedType === "exchange") { window.location.href = "exchanges.html"; }
    }

    function buildBell() {
        var style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);
        bell = document.createElement("button");
        bell.type = "button"; bell.className = "rx-bell"; bell.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>'; bell.setAttribute("aria-haspopup", "true");
        badge = document.createElement("span"); badge.className = "rx-badge"; badge.style.display = "none"; bell.appendChild(badge);
        panel = document.createElement("div"); panel.className = "rx-panel"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Notifications");
        panel.innerHTML = '<div class="rx-head"><span>Notifications</span><button type="button" class="rx-link" data-act="all">Mark all as read</button></div><ul class="rx-list"></ul>';
        list = panel.querySelector(".rx-list");
        document.body.appendChild(bell); document.body.appendChild(panel);
        // Prefer the dashboard header bell where one exists; use the floating bell on other pages.
        var headerBells = document.querySelectorAll(".notification-btn");
        if (headerBells.length) {
            bell.style.display = "none";
            headerBells.forEach(function (headerBell) {
                headerBell.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg><span class="rx-header-badge" aria-hidden="true"></span>';
                headerBell.setAttribute("aria-haspopup", "dialog");
                headerBell.setAttribute("aria-label", "Open notifications");
                headerBell.addEventListener("click", function () {
                    panel.classList.toggle("open");
                    if (panel.classList.contains("open")) refresh();
                });
            });
        }
        bell.addEventListener("click", function () { panel.classList.toggle("open"); if (panel.classList.contains("open")) refresh(); });
        panel.addEventListener("click", function (e) {
            if (e.target.getAttribute("data-act") === "all") { api("/notifications/read-all", { method: "PUT" }).then(refresh).catch(function () {}); return; }
            var item = e.target.closest(".rx-item"); if (item) openNotification(item.getAttribute("data-id"));
        });
        panel.addEventListener("keydown", function (e) { if (e.key === "Enter") { var item = e.target.closest(".rx-item"); if (item) openNotification(item.getAttribute("data-id")); } });
        document.addEventListener("click", function (e) { if (!panel.contains(e.target) && !bell.contains(e.target)) panel.classList.remove("open"); });
        document.addEventListener("keydown", function (e) { if (e.key === "Escape") { panel.classList.remove("open"); closeChat(); } });
        refresh(); state.pollTimer = setInterval(refresh, POLL_MS);
    }

    /* ---------------- request messaging ---------------- */
    var chat = { modal: null, body: null, input: null, error: null, send: null, requestId: null, timer: null, me: null };
    function currentUserId() {
        try { return String(JSON.parse(localStorage.getItem("resourceXCurrentUser") || "null").id); } catch (e) { return null; }
    }
    function buildChat() {
        chat.modal = document.createElement("div"); chat.modal.className = "rx-modal";
        chat.modal.innerHTML = '<div class="rx-chat" role="dialog" aria-modal="true" aria-label="Conversation"><div class="rx-head"><span>Conversation about this request</span><button type="button" class="rx-link" data-act="close">Close </button></div><div class="rx-chat-body" aria-live="polite"></div><div class="rx-error" hidden></div><form class="rx-chat-form"><input type="text" maxlength="2000" placeholder="Write a message (for example, pickup time)" aria-label="Message"><button class="rx-send" type="submit">Send</button></form></div>';
        document.body.appendChild(chat.modal);
        chat.body = chat.modal.querySelector(".rx-chat-body"); chat.input = chat.modal.querySelector("input");
        chat.error = chat.modal.querySelector(".rx-error"); chat.send = chat.modal.querySelector(".rx-send");
        chat.modal.addEventListener("click", function (e) { if (e.target === chat.modal || e.target.getAttribute("data-act") === "close") closeChat(); });
        chat.modal.querySelector("form").addEventListener("submit", function (e) {
            e.preventDefault();
            var content = chat.input.value.trim(); if (!content) return;
            chat.send.disabled = true; chat.error.hidden = true;
            api("/requests/" + chat.requestId + "/messages", { method: "POST", body: { content: content } })
                .then(function () { chat.input.value = ""; return loadMessages(); })
                .catch(function (err) { chat.error.textContent = err.message; chat.error.hidden = false; })
                .then(function () { chat.send.disabled = false; chat.input.focus(); });
        });
    }
    function loadMessages() {
        return api("/requests/" + chat.requestId + "/messages").then(function (data) {
            var atBottom = chat.body.scrollHeight - chat.body.scrollTop - chat.body.clientHeight < 60;
            var me = currentUserId();
            chat.body.innerHTML = data.messages.length ? data.messages.map(function (m) {
                var mine = String(m.senderId) === me;
                return '<div class="rx-msg ' + (mine ? "mine" : "") + '"><small>' + esc(mine ? "You" : m.senderName) + " · " + esc(timeAgo(m.sentAt)) + "</small>" + esc(m.content) + "</div>";
            }).join("") : '<div class="rx-empty">No messages yet. Say hello and agree on a pickup time.</div>';
            if (atBottom) chat.body.scrollTop = chat.body.scrollHeight;
            refresh();
        }).catch(function (err) { chat.body.innerHTML = '<div class="rx-empty">' + esc(err.message) + "</div>"; });
    }
    function openChat(requestId) {
        if (!token()) return;
        if (!chat.modal) buildChat();
        chat.requestId = requestId; chat.body.innerHTML = '<div class="rx-empty">Loading…</div>'; chat.error.hidden = true;
        chat.modal.classList.add("open");
        loadMessages().then(function () { chat.body.scrollTop = chat.body.scrollHeight; chat.input.focus(); });
        if (chat.timer) clearInterval(chat.timer);
        chat.timer = setInterval(loadMessages, CHAT_POLL_MS);
    }
    function closeChat() { if (chat.modal) chat.modal.classList.remove("open"); if (chat.timer) clearInterval(chat.timer); chat.timer = null; }

    window.ResourceXChat = { open: openChat, close: closeChat };
    window.resourceXNotifications = { refresh: refresh };

    function start() { if (token() && document.body && !document.querySelector(".rx-bell")) buildBell(); }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
