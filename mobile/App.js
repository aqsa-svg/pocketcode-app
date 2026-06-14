// PocketCode — React Native (Expo) app.
// Tabbed app with MULTIPLE simultaneous live sessions: Sessions · Chat · Inbox · Settings.
// End-to-end encrypted, wire-compatible with the web viewer and Node host.
import "react-native-get-random-values"; // must load before any crypto use
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList, KeyboardAvoidingView, Modal, Platform, SafeAreaView, ScrollView,
  StatusBar, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { encrypt, decrypt, keyFromB64url, parseConnectLink } from "./lib/crypto";

let Notifications = null;
try { Notifications = require("expo-notifications"); } catch {}

const C = {
  bg: "#07080c", panel: "#11131c", border: "#1d2030", text: "#e8eaf2",
  muted: "#8a8fa3", accent: "#7c5cff", green: "#3ddc84", red: "#ff6b6b", amber: "#febc2e",
};
const DEFAULT_RELAY = "wss://pocketcode-relay.onrender.com";
const APP_VERSION = "1.0.0";

let seq = 0;
const uid = () => `${Date.now()}-${++seq}`;

export default function App() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("sessions");

  const [sessions, setSessions] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [settings, setSettings] = useState({ defaultRelay: DEFAULT_RELAY, notifications: true });

  const [activeId, setActiveId] = useState(null);
  const [messagesMap, setMessagesMap] = useState({}); // id -> [msg]
  const [onlineMap, setOnlineMap] = useState({});     // id -> bool
  const [statusMap, setStatusMap] = useState({});     // id -> string
  const [busyMap, setBusyMap] = useState({});         // id -> bool
  const [input, setInput] = useState("");

  const [scanning, setScanning] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [editing, setEditing] = useState(null);
  const [permission, requestPermission] = useCameraPermissions();

  const conns = useRef(new Map());      // id -> { sock, key, label, reconnect:{timer,attempts,closed} }
  const messagesRef = useRef({});       // mirror of messagesMap for event handlers
  const sessionsRef = useRef([]);
  const settingsRef = useRef(settings);
  const listRef = useRef(null);

  // --- persistence -----------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const [s, i, cfg] = await Promise.all([
          AsyncStorage.getItem("pc_sessions"),
          AsyncStorage.getItem("pc_inbox"),
          AsyncStorage.getItem("pc_settings"),
        ]);
        if (s) { const arr = JSON.parse(s); setSessions(arr); sessionsRef.current = arr; }
        if (i) setInbox(JSON.parse(i));
        if (cfg) { const c = JSON.parse(cfg); setSettings(c); settingsRef.current = c; }
      } catch {}
      setReady(true);
    })();
  }, []);
  const persistSessions = (next) => { setSessions(next); sessionsRef.current = next; AsyncStorage.setItem("pc_sessions", JSON.stringify(next)).catch(() => {}); };
  const persistInbox = (next) => { setInbox(next); AsyncStorage.setItem("pc_inbox", JSON.stringify(next.slice(0, 200))).catch(() => {}); };
  const persistSettings = (next) => { setSettings(next); settingsRef.current = next; AsyncStorage.setItem("pc_settings", JSON.stringify(next)).catch(() => {}); };

  const labelFor = (id) => {
    const c = conns.current.get(id);
    if (c && c.label) return c.label;
    const s2 = sessionsRef.current.find((x) => x.id === id);
    return s2 ? s2.label : "session";
  };

  const addInbox = useCallback((kind, title, detail) => {
    setInbox((prev) => {
      const next = [{ id: uid(), ts: Date.now(), kind, title, detail: detail || "" }, ...prev];
      AsyncStorage.setItem("pc_inbox", JSON.stringify(next.slice(0, 200))).catch(() => {});
      return next;
    });
  }, []);

  // --- per-session state setters --------------------------------------------
  const setOnlineFor = (id, v) => setOnlineMap((m) => ({ ...m, [id]: v }));
  const setStatusFor = (id, v) => setStatusMap((m) => ({ ...m, [id]: v }));
  const setBusyFor = (id, v) => setBusyMap((m) => ({ ...m, [id]: v }));
  const addMsgTo = (id, kind, text, extra) => setMessagesMap((m) => {
    const list = [...(m[id] || []), { id: uid(), kind, text, ...extra }];
    const next = { ...m, [id]: list };
    messagesRef.current = next;
    return next;
  });

  useEffect(() => { if (listRef.current) setTimeout(() => listRef.current.scrollToEnd({ animated: true }), 50); }, [messagesMap, activeId]);

  // --- networking (one socket per session) -----------------------------------
  const sendEncTo = useCallback((id, obj) => {
    const c = conns.current.get(id);
    if (!c || !c.sock || c.sock.readyState !== 1) return;
    c.sock.send(JSON.stringify({ type: "enc", data: encrypt(c.key, JSON.stringify(obj)) }));
  }, []);

  const handle = useCallback((id, msg) => {
    if (msg.type === "joined") { setOnlineFor(id, true); setStatusFor(id, "online"); return; }
    if (msg.type === "status") {
      setOnlineFor(id, !!msg.hostOnline);
      setStatusFor(id, msg.hostOnline ? "online · CLI connected" : "waiting for CLI…");
      return;
    }
    if (msg.type !== "event") return;
    renderEvent(id, msg.event);
  }, []);

  function renderEvent(id, evt) {
    if (!evt || !evt.type) return;
    switch (evt.type) {
      case "user_prompt": addMsgTo(id, "user", evt.text); setBusyFor(id, true); break;
      case "system": if (evt.subtype === "init") addMsgTo(id, "sys", `session started · ${evt.model || "claude"}`); break;
      case "assistant": {
        const content = (evt.message && evt.message.content) || [];
        for (const b of content) {
          if (b.type === "text" && b.text && b.text.trim()) addMsgTo(id, "ai", b.text);
          else if (b.type === "tool_use") addMsgTo(id, "tool", `🔧 ${b.name}  ${summarize(b.input)}`);
        }
        break;
      }
      case "user": {
        const content = (evt.message && evt.message.content) || [];
        for (const b of content) if (b.type === "tool_result") {
          const t = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => c.text || "").join("") : "";
          if (t.trim()) addMsgTo(id, "result", "↳ " + truncate(t, 400));
        }
        break;
      }
      case "result": if (evt.total_cost_usd != null) addMsgTo(id, "sys", `done · $${Number(evt.total_cost_usd).toFixed(4)}`); break;
      case "approval_request":
        addMsgTo(id, "approval", "", { tool: evt.tool, input: evt.input, reqId: evt.id, decided: null });
        addInbox("approval", `✋ ${evt.tool} — ${labelFor(id)}`, describeTool(evt.tool, evt.input));
        break;
      case "vapid": if (settingsRef.current.notifications) registerPush(id); break;
      case "turn_complete": setBusyFor(id, false); addInbox("done", `✓ Finished — ${labelFor(id)}`); break;
      case "busy": addMsgTo(id, "sys", "CLI is busy with another prompt — try again in a sec."); setBusyFor(id, false); break;
      case "error": addMsgTo(id, "err", evt.text); setBusyFor(id, false); break;
      default: break;
    }
  }

  function openSock(sess, state) {
    clearTimeout(state.reconnect.timer);
    try { state.sock && state.sock.close(); } catch {}
    const sock = new WebSocket(sess.relayUrl);
    state.sock = sock;
    sock.onopen = () => {
      state.reconnect.attempts = 0;
      sock.send(JSON.stringify({ type: "join", room: sess.room, role: "viewer" }));
      sendEncTo(sess.id, { type: "client_hello" });
      setOnlineFor(sess.id, true); setStatusFor(sess.id, "connecting…");
    };
    sock.onclose = () => {
      setOnlineFor(sess.id, false);
      if (state.reconnect.closed) return;
      setStatusFor(sess.id, "reconnecting…");
      state.reconnect.attempts++;
      state.reconnect.timer = setTimeout(() => openSock(sess, state), Math.min(1000 * state.reconnect.attempts, 8000));
    };
    sock.onerror = () => setStatusFor(sess.id, "connection error");
    sock.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "enc") { let inner; try { inner = JSON.parse(decrypt(state.key, msg.data)); } catch { return; } handle(sess.id, inner); return; }
      handle(sess.id, msg);
    };
  }

  function connectSession(sess) {
    let st = conns.current.get(sess.id);
    if (st && st.sock && (st.sock.readyState === 0 || st.sock.readyState === 1) && !st.reconnect.closed) return; // already live
    st = st || { reconnect: { timer: null, attempts: 0, closed: false } };
    st.key = keyFromB64url(sess.keyB64url);
    st.label = sess.label;
    st.reconnect.closed = false;
    conns.current.set(sess.id, st);
    openSock(sess, st);
  }

  function disconnectSession(id) {
    const st = conns.current.get(id);
    if (st) { st.reconnect.closed = true; clearTimeout(st.reconnect.timer); try { st.sock && st.sock.close(); } catch {} }
    conns.current.delete(id);
    setOnlineFor(id, false); setStatusFor(id, "offline");
  }

  async function registerPush(id) {
    if (!Notifications) return;
    try {
      const { status: perm } = await Notifications.requestPermissionsAsync();
      if (perm !== "granted") return;
      const tok = await Notifications.getExpoPushTokenAsync();
      if (tok && tok.data) sendEncTo(id, { type: "push_subscription", sub: { expoToken: tok.data } });
    } catch {}
  }

  // --- actions ---------------------------------------------------------------
  function connectTo(sess) { connectSession(sess); setActiveId(sess.id); setTab("chat"); }

  function addFromLink(text) {
    const parsed = parseConnectLink(text);
    if (!parsed) { alert("Couldn't read that link/QR. Use the one your CLI printed (it has the room + key)."); return; }
    const host = (parsed.relayUrl.match(/\/\/([^/:]+)/) || [])[1] || "relay";
    const existing = sessions.find((s) => s.room === parsed.room && s.relayUrl === parsed.relayUrl);
    const sess = existing
      ? { ...existing, keyB64url: parsed.keyB64url }
      : { id: uid(), label: `${host.split(".")[0]} · ${parsed.room}`, relayUrl: parsed.relayUrl, room: parsed.room, keyB64url: parsed.keyB64url };
    const next = [sess, ...sessions.filter((s) => s.id !== sess.id)];
    persistSessions(next);
    setLinkText("");
    connectTo(sess);
  }

  function removeSession(id) {
    disconnectSession(id);
    persistSessions(sessions.filter((s) => s.id !== id));
    setMessagesMap((m) => { const n = { ...m }; delete n[id]; messagesRef.current = n; return n; });
    if (activeId === id) setActiveId(null);
  }

  function saveRename() {
    if (!editing) return;
    const label = (editing.label || "").trim() || "Session";
    persistSessions(sessions.map((x) => (x.id === editing.id ? { ...x, label } : x)));
    const c = conns.current.get(editing.id);
    if (c) c.label = label;
    setEditing(null);
  }

  function onScan({ data }) { setScanning(false); addFromLink(data); }
  async function openScanner() {
    if (!permission || !permission.granted) { const r = await requestPermission(); if (!r || !r.granted) return; }
    setScanning(true);
  }

  function send() {
    const text = input.trim();
    if (!text || !activeId) return;
    sendEncTo(activeId, { type: "prompt", text });
    setInput("");
  }
  function decide(msgId, decision) {
    const list = messagesRef.current[activeId] || [];
    const card = list.find((x) => x.id === msgId);
    setMessagesMap((m) => {
      const next = { ...m, [activeId]: (m[activeId] || []).map((x) => (x.id === msgId ? { ...x, decided: decision } : x)) };
      messagesRef.current = next;
      return next;
    });
    if (card && card.reqId) sendEncTo(activeId, { type: "approval_response", id: card.reqId, decision });
  }

  function clearEverything() {
    for (const id of Array.from(conns.current.keys())) disconnectSession(id);
    persistSessions([]); persistInbox([]); setMessagesMap({}); messagesRef.current = {}; setActiveId(null);
  }

  if (!ready) return <SafeAreaView style={s.safe}><StatusBar barStyle="light-content" /></SafeAreaView>;

  const messages = messagesMap[activeId] || [];
  const activeOnline = !!onlineMap[activeId];
  const activeStatus = activeId ? (statusMap[activeId] || "offline") : "offline";
  const activeBusy = !!busyMap[activeId];
  const liveCount = Object.values(onlineMap).filter(Boolean).length;

  const TABS = [
    { key: "sessions", icon: "🖥️", label: "Sessions" },
    { key: "chat", icon: "💬", label: "Chat" },
    { key: "inbox", icon: "📥", label: "Inbox" },
    { key: "settings", icon: "⚙️", label: "Settings" },
  ];

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" />

      {tab === "sessions" && (
        <View style={{ flex: 1 }}>
          <Header title="Sessions" sub={liveCount ? `${liveCount} live` : null} />
          <ScrollView contentContainerStyle={{ padding: 14 }}>
            <TouchableOpacity style={s.primaryBtn} onPress={openScanner}><Text style={s.primaryBtnText}>📷  Add by scanning QR</Text></TouchableOpacity>
            <Text style={s.or}>or paste the connect link</Text>
            <TextInput style={s.input} placeholder="https://…/?room=…#k=…" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} value={linkText} onChangeText={setLinkText} />
            <TouchableOpacity style={s.secondaryBtn} onPress={() => addFromLink(linkText)}><Text style={s.secondaryBtnText}>Add session →</Text></TouchableOpacity>

            <Text style={s.sectionLabel}>YOUR SESSIONS</Text>
            {sessions.length === 0 ? (
              <Text style={s.empty}>No sessions yet. Run <Text style={s.mono}>npx pocketcode</Text> on your computer and scan the QR.</Text>
            ) : sessions.map((sess) => {
              const isLive = conns.current.has(sess.id);
              return (
                <View key={sess.id} style={[s.sessionRow, activeId === sess.id && { borderColor: C.accent }]}>
                  <TouchableOpacity style={{ flex: 1 }} onPress={() => connectTo(sess)}>
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <View style={[s.dot, { backgroundColor: onlineMap[sess.id] ? C.green : isLive ? C.amber : C.muted, marginRight: 8, marginLeft: 0 }]} />
                      <Text style={s.sessionLabel}>{sess.label}</Text>
                    </View>
                    <Text style={s.sessionSub}>{isLive ? (statusMap[sess.id] || "connecting…") : "tap to connect"}</Text>
                  </TouchableOpacity>
                  {isLive ? <TouchableOpacity onPress={() => disconnectSession(sess.id)}><Text style={s.remove}>⏏️</Text></TouchableOpacity> : null}
                  <TouchableOpacity onPress={() => setEditing({ id: sess.id, label: sess.label })}><Text style={s.remove}>✏️</Text></TouchableOpacity>
                  <TouchableOpacity onPress={() => removeSession(sess.id)}><Text style={s.remove}>🗑</Text></TouchableOpacity>
                </View>
              );
            })}
          </ScrollView>
        </View>
      )}

      {tab === "chat" && (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Header title={activeId ? labelFor(activeId) : "Chat"} right={activeId ? <View style={[s.dot, { backgroundColor: activeOnline ? C.green : C.red }]} /> : null} sub={activeId ? activeStatus : null} />
          {!activeId ? (
            <View style={s.center}><Text style={s.empty}>No active session. Pick one in the Sessions tab.</Text></View>
          ) : (
            <>
              <FlatList ref={listRef} style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }} data={messages} keyExtractor={(it) => it.id} renderItem={({ item }) => <Bubble item={item} onDecide={decide} />} />
              {activeBusy ? <Text style={s.working}>Claude is working…</Text> : null}
              <View style={s.inputBar}>
                <TextInput style={s.promptInput} placeholder="Ask Claude Code anything…" placeholderTextColor={C.muted} value={input} onChangeText={setInput} onSubmitEditing={send} returnKeyType="send" />
                <TouchableOpacity style={s.sendBtn} onPress={send}><Text style={s.sendBtnText}>Send</Text></TouchableOpacity>
              </View>
            </>
          )}
        </KeyboardAvoidingView>
      )}

      {tab === "inbox" && (
        <View style={{ flex: 1 }}>
          <Header title="Inbox" right={inbox.length ? <TouchableOpacity onPress={() => persistInbox([])}><Text style={s.clearLink}>Clear</Text></TouchableOpacity> : null} />
          {inbox.length === 0 ? (
            <View style={s.center}><Text style={s.empty}>No activity yet. Approvals and finished tasks show up here.</Text></View>
          ) : (
            <FlatList data={inbox} keyExtractor={(it) => it.id} contentContainerStyle={{ padding: 14 }}
              renderItem={({ item }) => (
                <View style={s.inboxRow}>
                  <Text style={s.inboxIcon}>{item.kind === "approval" ? "✋" : "✓"}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.inboxTitle}>{item.title}</Text>
                    {item.detail ? <Text style={s.inboxDetail} numberOfLines={2}>{item.detail}</Text> : null}
                    <Text style={s.inboxTime}>{timeAgo(item.ts)}</Text>
                  </View>
                </View>
              )} />
          )}
        </View>
      )}

      {tab === "settings" && (
        <View style={{ flex: 1 }}>
          <Header title="Settings" />
          <ScrollView contentContainerStyle={{ padding: 14 }}>
            <Text style={s.sectionLabel}>DEFAULT RELAY</Text>
            <TextInput style={s.input} value={settings.defaultRelay} autoCapitalize="none" autoCorrect={false}
              onChangeText={(t) => persistSettings({ ...settings, defaultRelay: t })} />
            <View style={s.settingRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.settingTitle}>Notifications</Text>
                <Text style={s.settingSub}>Buzz for approvals & finished tasks</Text>
              </View>
              <Switch value={settings.notifications} onValueChange={(v) => persistSettings({ ...settings, notifications: v })}
                trackColor={{ true: C.accent, false: C.border }} />
            </View>
            <TouchableOpacity style={[s.secondaryBtn, { marginTop: 18 }]} onPress={clearEverything}>
              <Text style={[s.secondaryBtnText, { color: C.red }]}>Clear all sessions & history</Text>
            </TouchableOpacity>
            <Text style={s.sectionLabel}>ABOUT</Text>
            <Text style={s.aboutText}>PocketCode v{APP_VERSION}</Text>
            <Text style={s.aboutMuted}>Control Claude Code from your phone — end-to-end encrypted.</Text>
            <Text style={s.aboutMuted}>github.com/aqsa-svg/pocketcode-app</Text>
            <Text style={[s.aboutMuted, { marginTop: 10 }]}>Not affiliated with Anthropic.</Text>
          </ScrollView>
        </View>
      )}

      <View style={s.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity key={t.key} style={s.tabBtn} onPress={() => setTab(t.key)}>
            <Text style={[s.tabIcon, tab === t.key && { opacity: 1 }]}>{t.icon}</Text>
            <Text style={[s.tabLabel, tab === t.key && { color: C.accent }]}>{t.label}</Text>
            {t.key === "sessions" && liveCount > 0 ? <View style={s.badge} /> : null}
            {t.key === "inbox" && inbox.length > 0 ? <View style={s.badge} /> : null}
          </TouchableOpacity>
        ))}
      </View>

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={s.scanWrap}>
          <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScan} />
          <TouchableOpacity style={s.cancelScan} onPress={() => setScanning(false)}><Text style={s.cancelScanText}>Cancel</Text></TouchableOpacity>
        </View>
      </Modal>

      <Modal visible={!!editing} transparent animationType="fade" onRequestClose={() => setEditing(null)}>
        <View style={s.modalBackdrop}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Rename session</Text>
            <TextInput style={s.input} value={editing ? editing.label : ""} autoFocus
              onChangeText={(t) => setEditing((e) => ({ ...e, label: t }))} placeholder="Session name" placeholderTextColor={C.muted} />
            <View style={{ flexDirection: "row", marginTop: 12 }}>
              <TouchableOpacity style={[s.aBtn, s.denyBtn]} onPress={() => setEditing(null)}><Text style={s.denyText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[s.aBtn, s.approveBtn]} onPress={saveRename}><Text style={s.approveText}>Save</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Header({ title, sub, right }) {
  return (
    <View style={s.header}>
      <Text style={s.logoSmall}>⬡</Text>
      <View style={{ flex: 1 }}>
        <Text style={s.headerTitle}>{title}</Text>
        {sub ? <Text style={s.headerSub}>{sub}</Text> : null}
      </View>
      {right}
    </View>
  );
}

function Bubble({ item, onDecide }) {
  if (item.kind === "approval") {
    const detail = describeTool(item.tool, item.input);
    return (
      <View style={[s.rowFull, { marginBottom: 8 }]}>
        <View style={s.approval}>
          <Text style={s.approvalHead}>✋ Allow <Text style={{ color: C.text, fontWeight: "700" }}>{item.tool}</Text>?</Text>
          {detail ? <Text style={s.approvalBody}>{truncate(detail, 300)}</Text> : null}
          {item.decided ? (
            <Text style={s.approvalDone}>{item.decided === "allow" ? "✓ Approved" : "✗ Denied"}</Text>
          ) : (
            <View style={s.approvalBtns}>
              <TouchableOpacity style={[s.aBtn, s.denyBtn]} onPress={() => onDecide(item.id, "deny")}><Text style={s.denyText}>Deny</Text></TouchableOpacity>
              <TouchableOpacity style={[s.aBtn, s.approveBtn]} onPress={() => onDecide(item.id, "allow")}><Text style={s.approveText}>Approve</Text></TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    );
  }
  const map = { user: s.user, ai: s.ai, tool: s.tool, result: s.result, sys: s.sys, err: s.err };
  const isUser = item.kind === "user", isSys = item.kind === "sys";
  return (
    <View style={[s.bubbleRow, { alignItems: isSys ? "center" : isUser ? "flex-end" : "flex-start", marginBottom: 8 }]}>
      <Text style={[s.bubble, map[item.kind] || s.ai]}>{item.text}</Text>
    </View>
  );
}

function summarize(input) { return input ? truncate(JSON.stringify(input), 80) : ""; }
function truncate(str, n) { return str.length > n ? str.slice(0, n) + "…" : str; }
function describeTool(tool, input) {
  input = input || {};
  if (tool === "Bash") return input.command || "";
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") return input.file_path || input.notebook_path || "";
  if (tool === "WebFetch") return input.url || "";
  return truncate(JSON.stringify(input), 160);
}
function timeAgo(ts) {
  const d = Math.max(0, Date.now() - ts), m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  mono: { fontFamily: mono, color: C.text },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 30 },
  empty: { color: C.muted, textAlign: "center", fontSize: 14, lineHeight: 20 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, borderBottomColor: C.border, borderBottomWidth: 1, backgroundColor: C.panel },
  logoSmall: { fontSize: 18, color: C.accent, marginRight: 8 },
  headerTitle: { fontSize: 17, fontWeight: "700", color: C.text },
  headerSub: { fontSize: 11, color: C.muted },
  primaryBtn: { backgroundColor: C.accent, borderRadius: 12, padding: 15, alignItems: "center" },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  or: { color: C.muted, textAlign: "center", marginVertical: 12, fontSize: 13 },
  input: { backgroundColor: C.panel, borderColor: C.border, borderWidth: 1, borderRadius: 10, padding: 12, color: C.text, fontSize: 13 },
  secondaryBtn: { borderColor: C.border, borderWidth: 1, borderRadius: 10, padding: 12, alignItems: "center", marginTop: 10 },
  secondaryBtnText: { color: C.text, fontWeight: "600", fontSize: 15 },
  sectionLabel: { color: C.muted, fontSize: 11, fontWeight: "700", letterSpacing: 1, marginTop: 24, marginBottom: 10 },
  sessionRow: { flexDirection: "row", alignItems: "center", backgroundColor: C.panel, borderColor: C.border, borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 10 },
  sessionLabel: { color: C.text, fontSize: 15, fontWeight: "600" },
  sessionSub: { color: C.muted, fontSize: 12, marginTop: 3, marginLeft: 16 },
  remove: { fontSize: 17, paddingLeft: 12 },
  dot: { width: 9, height: 9, borderRadius: 5, marginLeft: "auto" },
  bubbleRow: { flexDirection: "column" },
  rowFull: { alignSelf: "stretch" },
  bubble: { maxWidth: "88%", padding: 11, borderRadius: 14, fontSize: 14, overflow: "hidden", color: C.text, lineHeight: 20 },
  user: { backgroundColor: C.accent, color: "#fff" },
  ai: { backgroundColor: C.panel, borderColor: C.border, borderWidth: 1, color: C.text },
  tool: { backgroundColor: "#0d1410", borderColor: "#1c3a28", borderWidth: 1, color: C.green, fontFamily: mono, fontSize: 12 },
  result: { backgroundColor: "#0d1018", borderColor: C.border, borderWidth: 1, color: C.muted, fontFamily: mono, fontSize: 12 },
  sys: { color: C.muted, fontSize: 12, backgroundColor: "transparent" },
  err: { backgroundColor: "#1a0d10", borderColor: "#3a1c1c", borderWidth: 1, color: C.red, fontSize: 13 },
  working: { color: C.muted, fontStyle: "italic", fontSize: 13, paddingHorizontal: 16, paddingBottom: 6 },
  inputBar: { flexDirection: "row", padding: 12, borderTopColor: C.border, borderTopWidth: 1, backgroundColor: C.panel },
  promptInput: { flex: 1, backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: C.text, fontSize: 15, marginRight: 10 },
  sendBtn: { backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 20, justifyContent: "center" },
  sendBtnText: { color: "#fff", fontWeight: "700" },
  approval: { backgroundColor: "#15120a", borderColor: "#4a3a14", borderWidth: 1, borderRadius: 14, padding: 13 },
  approvalHead: { color: C.amber, fontSize: 14, marginBottom: 8 },
  approvalBody: { backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: 9, padding: 10, color: C.text, fontSize: 12, fontFamily: mono, marginBottom: 10 },
  approvalBtns: { flexDirection: "row" },
  aBtn: { flex: 1, borderRadius: 10, padding: 12, alignItems: "center" },
  approveBtn: { backgroundColor: C.green, marginLeft: 5 },
  approveText: { color: "#04210f", fontWeight: "800", fontSize: 14 },
  denyBtn: { backgroundColor: "#2a1416", borderColor: "#3a1c1c", borderWidth: 1, marginRight: 5 },
  denyText: { color: C.red, fontWeight: "800", fontSize: 14 },
  approvalDone: { color: C.muted, fontWeight: "600", fontSize: 13 },
  inboxRow: { flexDirection: "row", alignItems: "center", backgroundColor: C.panel, borderColor: C.border, borderWidth: 1, borderRadius: 12, padding: 13, marginBottom: 9 },
  inboxIcon: { fontSize: 18, marginRight: 12 },
  inboxTitle: { color: C.text, fontSize: 14 },
  inboxDetail: { color: C.muted, fontSize: 12, fontFamily: mono, marginTop: 3 },
  inboxTime: { color: C.muted, fontSize: 12, marginTop: 4 },
  clearLink: { color: C.muted, fontSize: 13 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 28 },
  modalCard: { backgroundColor: C.panel, borderColor: C.border, borderWidth: 1, borderRadius: 16, padding: 18 },
  modalTitle: { color: C.text, fontSize: 16, fontWeight: "700", marginBottom: 12 },
  settingRow: { flexDirection: "row", alignItems: "center", marginTop: 22 },
  settingTitle: { color: C.text, fontSize: 15, fontWeight: "600" },
  settingSub: { color: C.muted, fontSize: 12, marginTop: 2 },
  aboutText: { color: C.text, fontSize: 14, fontWeight: "600" },
  aboutMuted: { color: C.muted, fontSize: 13, marginTop: 4 },
  tabBar: { flexDirection: "row", borderTopColor: C.border, borderTopWidth: 1, backgroundColor: C.panel, paddingBottom: Platform.OS === "ios" ? 6 : 0 },
  tabBtn: { flex: 1, alignItems: "center", paddingVertical: 9 },
  tabIcon: { fontSize: 20, opacity: 0.6 },
  tabLabel: { fontSize: 11, color: C.muted, marginTop: 2 },
  badge: { position: "absolute", top: 6, right: "30%", width: 8, height: 8, borderRadius: 4, backgroundColor: C.accent },
  scanWrap: { flex: 1, backgroundColor: "#000" },
  cancelScan: { position: "absolute", bottom: 44, alignSelf: "center", backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 },
  cancelScanText: { color: "#fff", fontSize: 16 },
});
