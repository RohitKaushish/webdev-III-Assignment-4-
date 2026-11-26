(() => {
  "use strict";

  // All user-supplied text is inserted with textContent only (never innerHTML),
  // so messages and names can't inject markup or scripts.
  const $ = (id) => document.getElementById(id);
  const joinScreen = $("join"), joinForm = $("join-form"), nameInput = $("name");
  const joinError = $("join-error"), joinBtn = $("join-btn");
  const app = $("app"), log = $("log"), jump = $("jump");
  const online = $("online"), status = $("status"), statusText = $("status-text");
  const banner = $("banner"), bannerText = $("banner-text");
  const typingEl = $("typing"), composer = $("composer"), input = $("input");
  const counter = $("counter"), sendBtn = $("send"), toast = $("toast"), leaveBtn = $("leave");
  const roomInput = $("room"), createBtn = $("create-btn"), roomLabel = $("room-code"), copyBtn = $("copy");

  const MAX_LEN = 500;
  const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,18}[\p{L}\p{N}]$/u; // mirrors the server
  const NAME_ERRORS = {
    NAME_INVALID: "Use 2 to 20 letters, numbers, spaces, dots, dashes or underscores.",
    NAME_TAKEN: "That name is already in use. Try another one.",
    TOO_MANY_CONNECTIONS: "Too many open tabs from this device. Close one and try again.",
    ROOM_INVALID: "Room codes have 6 letters or numbers, like K7M-4PX.",
    ROOM_NOT_FOUND: "No room with that code. Check it and try again.",
    ROOM_FULL: "That room is full.",
    TOO_MANY_ATTEMPTS: "Too many wrong codes. Wait a minute and try again.",
  };
  const ROOM_RE = /^[A-HJ-NP-Z2-9]{6}$/;
  let roomCode = "";

  let socket = null, me = "", joined = false, retryTimer = null, retries = 0;
  let lastGroup = null, lastUser = null, lastTs = 0, lastTypingSent = 0;
  const typers = new Map(); // user -> timeout id

  // ---------- Join ----------
  try { nameInput.value = sessionStorage.getItem("chatapp-name") || ""; } catch (_) {}
  nameInput.focus();

  function readName() {
    const name = nameInput.value.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (NAME_RE.test(name)) return name;
    showJoinError(NAME_ERRORS.NAME_INVALID);
    return null;
  }

  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = readName();
    if (!name) return;
    const code = roomInput.value.toUpperCase().replace(/[\s-]/g, "");
    if (!code) return showJoinError("Enter a room code, or create a new room.");
    if (!ROOM_RE.test(code)) return showJoinError(NAME_ERRORS.ROOM_INVALID);
    start(name, { room: code });
  });

  createBtn.addEventListener("click", () => {
    const name = readName();
    if (name) start(name, { create: true });
  });

  function start(name, extra) {
    showJoinError("");
    joinBtn.disabled = createBtn.disabled = true;
    joinBtn.textContent = "Joining";
    connect(name, extra);
  }

  function showJoinError(msg) {
    joinError.textContent = msg;
    joinBtn.disabled = createBtn.disabled = false;
    joinBtn.textContent = "Join room";
  }

  function connect(name, extra) {
    me = name;
    if (socket) socket.disconnect();
    // Same-origin connection; the name travels in the handshake and is validated by the server.
    socket = io({ transports: ["websocket"], auth: { name, ...extra }, reconnectionDelayMax: 5000 });

    socket.on("connect", () => {
      retries = 0;
      setStatus("online", "Connected");
      if (!joined) {
        joined = true;
        try { sessionStorage.setItem("chatapp-name", name); } catch (_) {}
        joinScreen.hidden = true;
        app.hidden = false;
        input.focus();
      }
      updateSend();
    });

    // The server tells us which room we are in. Reconnects must rejoin it, not create a new one.
    socket.on("room", (d) => {
      if (!d || typeof d.code !== "string") return;
      roomCode = d.code;
      socket.auth = { name: me, room: roomCode };
      roomLabel.textContent = `${roomCode.slice(0, 3)}-${roomCode.slice(3)}`;
    });

    socket.on("disconnect", () => { setStatus("offline", "Offline"); updateSend(); });
    socket.io.on("reconnect_attempt", () => setStatus("connecting", "Reconnecting"));

    socket.on("connect_error", (err) => {
      const code = err && err.message;
      if (NAME_ERRORS[code]) {
        // After a drop the server may not have released our name yet, so retry a few times.
        if (joined && code === "NAME_TAKEN" && retries++ < 5) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => socket && socket.connect(), 1500);
          return setStatus("connecting", "Reconnecting");
        }
        socket.disconnect();
        if (joined) { joined = false; app.hidden = true; joinScreen.hidden = false; }
        return showJoinError(NAME_ERRORS[code]);
      }
      if (joined) return setStatus("connecting", "Reconnecting");
      showJoinError("Can't reach the server. Retrying…");
      joinBtn.disabled = createBtn.disabled = true;
    });

    socket.on("history", (items) => {
      log.replaceChildren();
      lastGroup = lastUser = null;
      if (!Array.isArray(items) || !items.length) {
        const p = document.createElement("p");
        p.className = "empty";
        p.textContent = "No messages yet. Say hello to start the conversation.";
        log.append(p);
        return;
      }
      items.forEach((m) => renderMessage(m, true));
      scrollToBottom(true);
    });

    socket.on("chat", (m) => renderMessage(m, false));
    socket.on("join", (d) => notice(`${d.user} joined`));
    socket.on("leave", (d) => { notice(`${d.user} left`); clearTyper(d.user); });
    socket.on("active", (n) => { online.textContent = `${n} online`; });
    socket.on("announce", (text) => {
      if (typeof text !== "string" || !text) return;
      bannerText.textContent = text;
      banner.hidden = false;
    });
    socket.on("typing", (d) => {
      if (!d || typeof d.user !== "string" || d.user === me) return;
      clearTimeout(typers.get(d.user));
      typers.set(d.user, setTimeout(() => clearTyper(d.user), 3000));
      showTyping();
    });
  }

  function setStatus(state, text) { status.dataset.state = state; statusText.textContent = text; }

  // ---------- Rendering ----------
  function clearEmpty() { const e = log.querySelector(".empty"); if (e) e.remove(); }

  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 90; }
  function scrollToBottom(instant) {
    log.scrollTo({ top: log.scrollHeight, behavior: instant ? "instant" : "smooth" });
    jump.hidden = true;
  }
  log.addEventListener("scroll", () => { if (nearBottom()) jump.hidden = true; });
  jump.addEventListener("click", () => scrollToBottom(false));

  function colorIndex(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return h % 6;
  }
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function renderMessage(m, bulk) {
    if (!m || typeof m.user !== "string" || typeof m.text !== "string") return;
    clearEmpty();
    const wasNear = nearBottom();
    const own = m.user === me;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = m.text;

    const sameRun = lastGroup && lastUser === m.user && m.ts - lastTs < 120000;
    if (sameRun) {
      lastGroup.querySelector(".stack").append(bubble);
    } else {
      const group = document.createElement("div");
      group.className = "group" + (own ? " own" : "");
      if (!own) {
        const av = document.createElement("div");
        av.className = `avatar av-${colorIndex(m.user)}`;
        av.setAttribute("aria-hidden", "true");
        av.textContent = (Array.from(m.user)[0] || "?").toUpperCase();
        group.append(av);
      }
      const stack = document.createElement("div");
      stack.className = "stack";
      const meta = document.createElement("div");
      meta.className = "meta";
      const who = document.createElement("b");
      who.textContent = own ? "You" : m.user;
      const time = document.createElement("time");
      time.dateTime = new Date(m.ts).toISOString();
      time.textContent = fmtTime(m.ts);
      meta.append(who, time);
      stack.append(meta, bubble);
      group.append(stack);
      log.append(group);
      lastGroup = group;
    }
    lastUser = m.user;
    lastTs = m.ts;
    if (!own) clearTyper(m.user);
    if (bulk) return;
    if (own || wasNear) scrollToBottom(false);
    else jump.hidden = false;
  }

  function notice(text) {
    clearEmpty();
    const wasNear = nearBottom();
    const el = document.createElement("div");
    el.className = "notice";
    el.textContent = text;
    log.append(el);
    lastGroup = lastUser = null;
    if (wasNear) scrollToBottom(false);
  }

  // ---------- Typing indicator ----------
  function clearTyper(user) { clearTimeout(typers.get(user)); typers.delete(user); showTyping(); }
  function showTyping() {
    const names = [...typers.keys()];
    typingEl.textContent =
      names.length === 0 ? "" :
      names.length === 1 ? `${names[0]} is typing…` :
      names.length === 2 ? `${names[0]} and ${names[1]} are typing…` :
      "Several people are typing…";
  }

  // ---------- Composer ----------
  function updateSend() { sendBtn.disabled = !(socket && socket.connected && input.value.trim()); }
  function resize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
  function updateCounter() {
    const n = input.value.length;
    counter.textContent = n > 400 ? `${n}/${MAX_LEN}` : "";
    counter.classList.toggle("near", n > 470);
  }

  input.addEventListener("input", () => {
    resize(); updateCounter(); updateSend();
    const now = Date.now();
    if (socket && socket.connected && input.value && now - lastTypingSent > 2000) {
      lastTypingSent = now;
      socket.emit("typing");
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); composer.requestSubmit(); }
  });

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !socket || !socket.connected) return;
    input.value = "";
    resize(); updateCounter(); updateSend();
    socket.emit("msg", text, (res) => {
      if (res && res.ok) return;
      if (!input.value) { input.value = text; resize(); updateCounter(); updateSend(); } // give the draft back
      showToast((res && res.error) || "Message not sent. Try again.");
    });
  });

  // ---------- Copy room code ----------
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      showToast("Room code copied. Share it with the person you want to chat with.", false);
    } catch (_) {
      showToast(`Your room code is ${roomLabel.textContent}`, false);
    }
  });

  // ---------- Leave ----------
  leaveBtn.addEventListener("click", () => {
    clearTimeout(retryTimer);
    if (socket) { socket.disconnect(); socket = null; } // server announces "left" to everyone else
    joined = false;
    log.replaceChildren();
    lastGroup = lastUser = null;
    typers.forEach((t) => clearTimeout(t));
    typers.clear();
    typingEl.textContent = "";
    input.value = "";
    resize(); updateCounter(); updateSend();
    banner.hidden = true;
    jump.hidden = true;
    online.textContent = "0 online";
    roomCode = "";
    roomLabel.textContent = "";
    roomInput.value = "";
    setStatus("connecting", "Connecting");
    try { sessionStorage.removeItem("chatapp-name"); } catch (_) {}
    app.hidden = true;
    joinScreen.hidden = false;
    showJoinError("");
    nameInput.value = "";
    nameInput.focus();
  });

  banner.querySelector("button").addEventListener("click", () => { banner.hidden = true; });

  let toastTimer;
  function showToast(msg, isError = true) {
    toast.textContent = msg;
    toast.classList.toggle("info", !isError);
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 4000);
  }
})();
