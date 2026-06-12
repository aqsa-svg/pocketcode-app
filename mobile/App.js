// PocketCode — React Native (Expo) app.
// Control Claude Code from a real native app: scan the QR your CLI prints,
// then chat + approve tools. End-to-end encrypted, wire-compatible with the
// web viewer and Node host.
import "react-native-get-random-values"; // must load before any crypto use
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList, KeyboardAvoidingView, Modal, Platform,
  SafeAreaView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { encrypt, decrypt, parseConnectLink } from "./lib/crypto";

let Notifications = null;
try { Notifications = require("expo-notifications"); } catch {}

const C = {
  bg: "#07080c", panel: "#11131c", border: "#1d2030", text: "#e8eaf2",
  muted: "#8a8fa3", accent: "#7c5cff", green: "#3ddc84", red: "#ff6b6b", amber: "#febc2e",
};

let msgSeq = 0;
const nextId = () => `m${++msgSeq}`;

export default function App() {
  const [phase, setPhase] = useState("connect"); // "connect" | "chat"
  const [linkText, setLinkText] = useState("");
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("offline");
  const [online, setOnline] = useState(false);

  const session = useRef(null); // { relayUrl, room, key }
  const ws = useRef(null);
  const reconnect = useRef({ timer: null, attempts: 0, closed: false });
  const listRef = useRef(null);
  const messagesRef = useRef([]);

  const addMsg = useCallback((kind, text, extra) => {
    setMessages((m) => {
      const next = [...m, { id: nextId(), kind, text, ...extra }];
      messagesRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (listRef.current) setTimeout(() => listRef.current.scrollToEnd({ animated: true }), 50);
  }, [messages]);

  // --- socket ----------------------------------------------------------------
  const sendEnc = useCallback((obj) => {
    const sock = ws.current;
    if (!sock || sock.readyState !== 1 || !session.current) return;
    sock.send(JSON.stringify({ type: "enc", data: encrypt(session.current.key, JSON.stringify(obj)) }));
  }, []);

  const handle = useCallback((msg) => {
    if (msg.type === "joined") { setOnline(true); setStatus("online"); return; }
    if (msg.type === "status") {
      setOnline(!!msg.hostOnline);
      setStatus(msg.hostOnline ? "online · CLI connected" : "waiting for CLI…");
      return;
    }
    if (msg.type !== "event") return;
    render(msg.event);
  }, []);

  const openSocket = useCallback(() => {
    const sess = session.current;
    if (!sess) return;
    clearTimeout(reconnect.current.timer);
    const sock = new WebSocket(sess.relayUrl);
    ws.current = sock;

    sock.onopen = () => {
      reconnect.current.attempts = 0;
      sock.send(JSON.stringify({ type: "join", room: sess.room, role: "viewer" }));
      sendEnc({ type: "client_hello" });
      setOnline(true);
      setStatus("connecting…");
    };
    sock.onclose = () => {
      setOnline(false);
      if (reconnect.current.closed) return;
      setStatus("reconnecting…");
      reconnect.current.attempts++;
      const delay = Math.min(1000 * reconnect.current.attempts, 8000);
      reconnect.current.timer = setTimeout(openSocket, delay);
    };
    sock.onerror = () => setStatus("connection error");
    sock.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "enc") {
        let inner;
        try { inner = JSON.parse(decrypt(sess.key, msg.data)); } catch { return; }
        handle(inner);
        return;
      }
      handle(msg);
    };
  }, [sendEnc, handle]);

  // render() and registerPush() referenced by handle() — defined as plain
  // functions that close over the stable callbacks above.
  function render(evt) {
    if (!evt || !evt.type) return;
    switch (evt.type) {
      case "user_prompt": addMsg("user", evt.text); setBusy(true); break;
      case "system":
        if (evt.subtype === "init") addMsg("sys", `session started · ${evt.model || "claude"}`);
        break;
      case "assistant": {
        const content = (evt.message && evt.message.content) || [];
        for (const b of content) {
          if (b.type === "text" && b.text && b.text.trim()) addMsg("ai", b.text);
          else if (b.type === "tool_use") addMsg("tool", `🔧 ${b.name}  ${summarize(b.input)}`);
        }
        break;
      }
      case "user": {
        const content = (evt.message && evt.message.content) || [];
        for (const b of content) {
          if (b.type === "tool_result") {
            const t = typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content) ? b.content.map((c) => c.text || "").join("") : "";
            if (t.trim()) addMsg("result", "↳ " + truncate(t, 400));
          }
        }
        break;
      }
      case "result":
        if (evt.total_cost_usd != null) addMsg("sys", `done · $${Number(evt.total_cost_usd).toFixed(4)}`);
        break;
      case "approval_request":
        addMsg("approval", "", { tool: evt.tool, input: evt.input, reqId: evt.id, decided: null });
        break;
      case "vapid": registerPush(); break;
      case "turn_complete": setBusy(false); break;
      case "busy": addMsg("sys", "CLI is busy with another prompt — try again in a sec."); setBusy(false); break;
      case "error": addMsg("err", evt.text); setBusy(false); break;
      default: break;
    }
  }

  async function registerPush() {
    if (!Notifications) return;
    try {
      const { status: perm } = await Notifications.requestPermissionsAsync();
      if (perm !== "granted") return;
      const tok = await Notifications.getExpoPushTokenAsync();
      if (tok && tok.data) sendEnc({ type: "push_subscription", sub: { expoToken: tok.data } });
    } catch { /* push not available in this runtime — in-app approvals still work */ }
  }

  // --- connect ---------------------------------------------------------------
  function startFromLink(text) {
    const parsed = parseConnectLink(text);
    if (!parsed) {
      setPhase("chat");
      setMessages([]);
      messagesRef.current = [];
      addMsg("err", "Couldn't read that link. Use the QR / link your CLI printed (it has the room + key).");
      return;
    }
    session.current = parsed;
    setMessages([]);
    messagesRef.current = [];
    setPhase("chat");
    reconnect.current.closed = false;
    openSocket();
  }

  function onScan({ data }) {
    setScanning(false);
    startFromLink(data);
  }

  async function openScanner() {
    if (!permission || !permission.granted) {
      const res = await requestPermission();
      if (!res || !res.granted) return;
    }
    setScanning(true);
  }

  function decideApproval(id, decision) {
    const card = messagesRef.current.find((x) => x.id === id);
    setMessages((m) => {
      const next = m.map((x) => (x.id === id ? { ...x, decided: decision } : x));
      messagesRef.current = next;
      return next;
    });
    if (card && card.reqId) sendEnc({ type: "approval_response", id: card.reqId, decision });
  }

  function send() {
    const text = input.trim();
    if (!text) return;
    sendEnc({ type: "prompt", text });
    setInput("");
  }

  function disconnect() {
    reconnect.current.closed = true;
    clearTimeout(reconnect.current.timer);
    try { ws.current && ws.current.close(); } catch {}
    setPhase("connect");
    setOnline(false);
    setStatus("offline");
  }

  // --- render: connect screen ------------------------------------------------
  if (phase === "connect") {
    return (
      <SafeAreaView style={s.safe}>
        <StatusBar barStyle="light-content" />
        <View style={s.connectWrap}>
          <Text style={s.logo}>⬡</Text>
          <Text style={s.h1}>PocketCode</Text>
          <Text style={s.sub}>Run <Text style={s.mono}>npx pocketcode</Text> on your computer, then scan the QR it prints.</Text>

          <TouchableOpacity style={s.primaryBtn} onPress={openScanner}>
            <Text style={s.primaryBtnText}>📷  Scan QR code</Text>
          </TouchableOpacity>

          <Text style={s.or}>or paste the link</Text>
          <TextInput
            style={s.input}
            placeholder="https://…/?room=…#k=…"
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            autoCorrect={false}
            value={linkText}
            onChangeText={setLinkText}
          />
          <TouchableOpacity style={s.secondaryBtn} onPress={() => startFromLink(linkText)}>
            <Text style={s.secondaryBtnText}>Connect →</Text>
          </TouchableOpacity>
        </View>

        <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
          <View style={s.scanWrap}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={onScan}
            />
            <TouchableOpacity style={s.cancelScan} onPress={() => setScanning(false)}>
              <Text style={s.cancelScanText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  // --- render: chat screen ---------------------------------------------------
  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" />
      <View style={s.header}>
        <Text style={s.logoSmall}>⬡</Text>
        <Text style={s.headerTitle}>PocketCode</Text>
        <View style={[s.dot, { backgroundColor: online ? C.green : C.red }]} />
        <Text style={s.headerStatus}>{status}</Text>
        <TouchableOpacity onPress={disconnect}><Text style={s.disconnect}>✕</Text></TouchableOpacity>
      </View>

      <FlatList
        ref={listRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 14 }}
        data={messages}
        keyExtractor={(it) => it.id}
        renderItem={({ item }) => <Bubble item={item} onDecide={decideApproval} />}
      />

      {busy ? <Text style={s.working}>Claude is working…</Text> : null}

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={s.inputBar}>
          <TextInput
            style={s.promptInput}
            placeholder="Ask Claude Code anything…"
            placeholderTextColor={C.muted}
            value={input}
            onChangeText={setInput}
            onSubmitEditing={send}
            returnKeyType="send"
          />
          <TouchableOpacity style={s.sendBtn} onPress={send}><Text style={s.sendBtnText}>Send</Text></TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
  const isUser = item.kind === "user";
  const isSys = item.kind === "sys";
  return (
    <View style={[s.bubbleRow, { alignItems: isSys ? "center" : isUser ? "flex-end" : "flex-start", marginBottom: 8 }]}>
      <Text style={[s.bubble, map[item.kind] || s.ai]}>{item.text}</Text>
    </View>
  );
}

function summarize(input) {
  if (!input) return "";
  return truncate(JSON.stringify(input), 80);
}
function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + "…" : str;
}
function describeTool(tool, input) {
  input = input || {};
  if (tool === "Bash") return input.command || "";
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") return input.file_path || input.notebook_path || "";
  if (tool === "WebFetch") return input.url || "";
  return truncate(JSON.stringify(input), 160);
}

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  mono: { fontFamily: mono, color: C.text },
  connectWrap: { flex: 1, justifyContent: "center", padding: 28 },
  logo: { fontSize: 44, color: C.accent, textAlign: "center" },
  h1: { fontSize: 28, fontWeight: "800", color: C.text, textAlign: "center", marginTop: 6 },
  sub: { fontSize: 14, color: C.muted, textAlign: "center", marginTop: 10, marginBottom: 26, lineHeight: 20 },
  primaryBtn: { backgroundColor: C.accent, borderRadius: 12, padding: 16, alignItems: "center" },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  or: { color: C.muted, textAlign: "center", marginVertical: 16, fontSize: 13 },
  input: { backgroundColor: C.panel, borderColor: C.border, borderWidth: 1, borderRadius: 10, padding: 13, color: C.text, fontSize: 13 },
  secondaryBtn: { borderColor: C.border, borderWidth: 1, borderRadius: 10, padding: 13, alignItems: "center", marginTop: 10 },
  secondaryBtnText: { color: C.text, fontWeight: "600", fontSize: 15 },
  scanWrap: { flex: 1, backgroundColor: "#000" },
  cancelScan: { position: "absolute", bottom: 44, alignSelf: "center", backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 },
  cancelScanText: { color: "#fff", fontSize: 16 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, borderBottomColor: C.border, borderBottomWidth: 1, backgroundColor: C.panel },
  logoSmall: { fontSize: 18, color: C.accent, marginRight: 8 },
  headerTitle: { fontSize: 16, fontWeight: "700", color: C.text },
  dot: { width: 8, height: 8, borderRadius: 4, marginLeft: "auto", marginRight: 6 },
  headerStatus: { fontSize: 12, color: C.muted },
  disconnect: { fontSize: 18, color: C.muted, marginLeft: 12 },
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
  inputBar: { flexDirection: "row", padding: 12, borderTopColor: C.border, borderTopWidth: 1, backgroundColor: C.panel },
  promptInput: { flex: 1, backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: C.text, fontSize: 15, marginRight: 10 },
  sendBtn: { backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 20, justifyContent: "center" },
  sendBtnText: { color: "#fff", fontWeight: "700" },
});
