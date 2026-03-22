import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

function getApiBase() {
  const isLocalDev =
    ["localhost", "127.0.0.1"].includes(window.location.hostname) && window.location.port === "5173";

  if (isLocalDev) {
    return `${window.location.protocol}//${window.location.hostname}:3001`;
  }

  return window.location.origin;
}

const API_BASE = getApiBase();
const DEFAULT_RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

const STREAM_QUALITY_PRESETS = {
  smooth: {
    label: "480p",
    width: 854,
    height: 480,
    fps: 24,
    bitrate: 1_500_000,
    degradationPreference: "maintain-framerate"
  },
  balanced: {
    label: "720p",
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 5_000_000,
    degradationPreference: "balanced"
  },
  sharp: {
    label: "1080p",
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 15_000_000,
    degradationPreference: "maintain-resolution"
  },
  ultra: {
    label: "Ultra",
    width: 2560,
    height: 1440,
    fps: 30,
    bitrate: 24_000_000,
    degradationPreference: "maintain-resolution"
  }
};

function getRoomIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("room") || "";
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

function normalizeUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.includes(".") && !trimmed.includes(" ")) {
    return `https://${trimmed}`;
  }

  return `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}`;
}

function parseRoomInput(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return (url.searchParams.get("room") || "").toUpperCase();
    } catch (_error) {
      return "";
    }
  }

  return trimmed.toUpperCase();
}

function getDomainLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_error) {
    return "";
  }
}

function getEmbedWarning(url) {
  const hostname = getDomainLabel(url);
  if (!hostname) {
    return "";
  }

  const blockedPatterns = [
    "google.com",
    "netflix.com",
    "primevideo.com",
    "hotstar.com",
    "disneyplus.com",
    "hulu.com",
    "max.com",
    "youtube.com",
    "bing.com"
  ];

  if (blockedPatterns.some((pattern) => hostname.includes(pattern))) {
    return `${hostname} usually blocks loading inside a website iframe. That is why it looks like a broken browser here.`;
  }

  return "";
}

function App() {
  const desktopHost = window.desktopHost || null;
  const [username, setUsername] = useState("");
  const [draftName, setDraftName] = useState("");
  const [roomId, setRoomId] = useState(getRoomIdFromUrl());
  const [joinRoomInput, setJoinRoomInput] = useState(getRoomIdFromUrl());
  const [socket, setSocket] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [ownerId, setOwnerId] = useState(null);
  const [controllerId, setControllerId] = useState(null);
  const [controlRequests, setControlRequests] = useState([]);
  const [browserState, setBrowserState] = useState({
    url: "",
    query: "",
    status: "ready",
    updatedAt: null,
    frame: null,
    aspectRatio: 16 / 9
  });
  const [browserInput, setBrowserInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [chatDraft, setChatDraft] = useState("");
  const [error, setError] = useState("");
  const [browserWarning, setBrowserWarning] = useState("");
  const [copied, setCopied] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [desktopBrowserState, setDesktopBrowserState] = useState({
    isOpen: false,
    url: "",
    title: "",
    isCapturing: false,
    lastCaptureAt: null,
    isStreaming: false
  });
  const [browserStreamReady, setBrowserStreamReady] = useState(false);
  const [browserRemoteReady, setBrowserRemoteReady] = useState(false);
  const [receiverQuality, setReceiverQuality] = useState("sharp");
  const [browserVolume, setBrowserVolume] = useState(100);
  const [theaterMode, setTheaterMode] = useState(false);
  const [sidebarTab, setSidebarTab] = useState("call");
  const [controlNotice, setControlNotice] = useState("");
  const [browserInteractionActive, setBrowserInteractionActive] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [rtcConfig, setRtcConfig] = useState(DEFAULT_RTC_CONFIG);

  const localVideoRef = useRef(null);
  const remoteVideoRefs = useRef(new Map());
  const peersRef = useRef(new Map());
  const browserPeersRef = useRef(new Map());
  const localStreamRef = useRef(null);
  const browserStreamRef = useRef(null);
  const browserPreviewRef = useRef(null);
  const browserRemoteVideoRef = useRef(null);
  const browserRemoteStreamRef = useRef(null);
  const browserStageRef = useRef(null);
  const roomPageRef = useRef(null);
  const socketRef = useRef(null);
  const roomIdRef = useRef(roomId);
  const requestedBrowserQualityRef = useRef(new Map());
  const browserInteractionRef = useRef(null);

  const selfId = socket?.id || null;
  const isOwner = selfId && ownerId === selfId;
  const hasBrowserControl = Boolean(selfId && (selfId === ownerId || selfId === controllerId));
  const invitationLink = roomId ? `${window.location.origin}?room=${roomId}` : "";
  const controllerParticipant = controllerId ? participants.find((participant) => participant.id === controllerId) : null;
  const controllerDisplayName = controllerParticipant ? controllerParticipant.username : null;
  const peopleCountLabel = `${participants.length} joined`;
  const pendingRequestCount = controlRequests.length;
  const othersInCallCount = Math.max(participants.length - 1, 0);

  async function tuneBrowserSender(sender, qualityKey = "sharp") {
    if (!sender) {
      return;
    }

    const preset = STREAM_QUALITY_PRESETS[qualityKey] || STREAM_QUALITY_PRESETS.sharp;

    try {
      const parameters = sender.getParameters();
      const nextParameters = {
        ...parameters,
        degradationPreference: preset.degradationPreference,
        encodings:
          parameters.encodings && parameters.encodings.length > 0
            ? parameters.encodings.map((encoding) => ({
                ...encoding,
                maxBitrate: preset.bitrate,
                minBitrate: qualityKey === "sharp" ? 6_000_000 : undefined,
                maxFramerate: preset.fps,
                scaleResolutionDownBy: 1
              }))
            : [
                {
                  maxBitrate: preset.bitrate,
                  minBitrate: qualityKey === "sharp" ? 6_000_000 : undefined,
                  maxFramerate: preset.fps,
                  scaleResolutionDownBy: 1
                }
              ]
      };

      await sender.setParameters(nextParameters);
    } catch (_error) {
      // Browser/Electron may reject some sender tuning fields on some platforms.
    }
  }

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    const existingName = window.localStorage.getItem("watchparty-name");
    if (existingName) {
      setDraftName(existingName);
      setUsername(existingName);
    }
  }, []);

  useEffect(() => {
    if (roomId) {
      const url = new URL(window.location.href);
      url.searchParams.set("room", roomId);
      window.history.replaceState({}, "", url);
    }
  }, [roomId]);

  useEffect(() => {
    let cancelled = false;

    async function setupLocalMedia() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch (mediaError) {
        console.error(mediaError);
        setError("Camera or microphone access was denied. Chat and synced browsing still work.");
      }
    }

    setupLocalMedia();

    return () => {
      cancelled = true;
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
      localVideoRef.current.play().catch(() => {});
    }
  }, [roomId, username]);

  useEffect(() => {
    async function applyLiveQuality() {
      if (!browserStreamRef.current) {
        return;
      }

      for (const { connection } of browserPeersRef.current.values()) {
        const sender = connection.getSenders().find((item) => item.track?.kind === "video");
        await tuneBrowserSender(sender, "sharp");
      }
    }

    applyLiveQuality();
  }, [browserStreamReady]);

  useEffect(() => {
    if (browserPreviewRef.current && browserStreamRef.current) {
      browserPreviewRef.current.srcObject = browserStreamRef.current;
      browserPreviewRef.current.volume = browserVolume / 100;
      browserPreviewRef.current.play().catch(() => {});
    }
  }, [browserStreamReady, browserVolume]);

  useEffect(() => {
    if (browserRemoteVideoRef.current && browserRemoteStreamRef.current) {
      browserRemoteVideoRef.current.srcObject = browserRemoteStreamRef.current;
      browserRemoteVideoRef.current.volume = browserVolume / 100;
      browserRemoteVideoRef.current.play().catch(() => {});
    }
  }, [browserRemoteReady, browserVolume]);

  useEffect(() => {
    if (sidebarTab === "chat") {
      setUnreadChatCount(0);
    }
  }, [sidebarTab]);

  useEffect(() => {
    let cancelled = false;

    async function loadRuntimeConfig() {
      try {
        const response = await fetch(`${API_BASE}/api/config`);
        if (!response.ok) {
          return;
        }

        const data = await response.json();
        if (!cancelled && Array.isArray(data?.iceServers) && data.iceServers.length > 0) {
          setRtcConfig({ iceServers: data.iceServers });
        }
      } catch (_error) {
        // Fall back to default STUN-only config when runtime config is unavailable.
      }
    }

    loadRuntimeConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!desktopHost) {
      return undefined;
    }

    const unsubscribeState = desktopHost.onHostBrowserState((payload) => {
      setDesktopBrowserState((current) => ({
        ...current,
        ...payload
      }));
    });

    return () => {
      unsubscribeState?.();
    };
  }, [desktopHost]);

  useEffect(() => {
    if (!roomId || !username) {
      return undefined;
    }

    const nextSocket = io(API_BASE, {
      transports: ["websocket"]
    });

    socketRef.current = nextSocket;
    setSocket(nextSocket);

    nextSocket.on("connect", () => {
      nextSocket.emit("join-room", {
        roomId,
        username
      });
    });

    nextSocket.on("room-error", ({ message }) => {
      setError(message);
    });

    nextSocket.on("room-state", (state) => {
      setParticipants(state.participants);
      setOwnerId(state.ownerId);
      setControllerId(state.controllerId || null);
      setControlRequests(state.controlRequests || []);
      setBrowserState(state.browserState);
      setBrowserInput(state.browserState.query || state.browserState.url || "");
      setBrowserWarning(state.browserState.status?.startsWith("desktop-") ? "" : getEmbedWarning(state.browserState.url));
      setMessages(state.chat);
      setUnreadChatCount(0);
    });

    nextSocket.on("presence-update", (state) => {
      setParticipants(state.participants);
      setOwnerId(state.ownerId);
      setControllerId(state.controllerId || null);
      setControlRequests(state.controlRequests || []);
    });

    nextSocket.on("participant-joined", async ({ participant }) => {
      setParticipants((current) => {
        const withoutDuplicate = current.filter((item) => item.id !== participant.id);
        return [...withoutDuplicate, participant];
      });

      if (participant.id !== nextSocket.id) {
        await createOfferForParticipant(participant.id, nextSocket);
        if (browserStreamRef.current) {
          await createBrowserOfferForParticipant(participant.id, nextSocket);
        }
      }
    });

    nextSocket.on("participant-left", ({ participantId }) => {
      setParticipants((current) => current.filter((item) => item.id !== participantId));
      removePeer(participantId);
      removeBrowserPeer(participantId);
    });

    nextSocket.on("chat-message", (message) => {
      setMessages((current) => [...current, message]);
      if (message.senderId !== nextSocket.id && sidebarTab !== "chat") {
        setUnreadChatCount((current) => current + 1);
      }
    });

    nextSocket.on("browser-update", (nextState) => {
      setBrowserState(nextState);
      setBrowserWarning(nextState.status?.startsWith("desktop-") ? "" : getEmbedWarning(nextState.url));
      if (!(ownerId === nextSocket.id)) {
        setBrowserInput(nextState.query || nextState.url || "");
      }
    });

    nextSocket.on("webrtc-signal", async ({ senderId, signal }) => {
      if (signal.channel === "browser") {
        await handleBrowserSignal(senderId, signal, nextSocket);
      } else {
        await handleSignal(senderId, signal, nextSocket);
      }
    });

    nextSocket.on("browser-quality-request", async ({ requesterId, quality }) => {
      requestedBrowserQualityRef.current.set(requesterId, quality);
      const peer = browserPeersRef.current.get(requesterId);
      if (!peer) {
        return;
      }

      const sender = peer.connection.getSenders().find((item) => item.track?.kind === "video");
      await tuneBrowserSender(sender, quality);
    });

    nextSocket.on("browser-control-state", ({ controllerId: nextControllerId, controlRequests: nextRequests }) => {
      setControllerId(nextControllerId || null);
      setControlRequests(nextRequests || []);
    });

    nextSocket.on("browser-command", async ({ command, payload }) => {
      if (!desktopHost) {
        return;
      }

      if (command === "navigate" && payload?.url) {
        await desktopHost.openHostBrowser();
        await desktopHost.navigateHostBrowser(payload.url);
        setBrowserInput(payload.url);
        return;
      }

      if (command === "refresh") {
        await desktopHost.refreshHostBrowser();
        return;
      }

      if (command === "back") {
        await desktopHost.goBackHostBrowser();
        return;
      }

      if (command === "forward") {
        await desktopHost.goForwardHostBrowser();
        return;
      }

      if (command === "mouse-event") {
        await desktopHost.sendHostBrowserMouseEvent(payload);
        return;
      }

      if (command === "key-event") {
        await desktopHost.sendHostBrowserKeyEvent(payload);
      }
    });

    return () => {
      nextSocket.disconnect();
      peersRef.current.forEach((_, participantId) => removePeer(participantId));
      browserPeersRef.current.forEach((_, participantId) => removeBrowserPeer(participantId));
      setSocket(null);
    };
  }, [roomId, username]);

  useEffect(() => {
    if (!socketRef.current || !roomId || isOwner) {
      return;
    }

    socketRef.current.emit("browser-quality-request", {
      roomId,
      quality: receiverQuality
    });
  }, [receiverQuality, roomId, isOwner]);

  useEffect(() => {
    if (!roomId) {
      return undefined;
    }

    let cancelled = false;

    async function loadControlState() {
      try {
        const response = await fetch(`${API_BASE}/api/rooms/${roomId}/control`);
        if (!response.ok) {
          return;
        }

        const data = await response.json();
        if (cancelled) {
          return;
        }

        setControllerId(data.controllerId || null);
        setControlRequests(data.controlRequests || []);
      } catch (_error) {
        // Ignore transient polling failures.
      }
    }

    loadControlState();
    const intervalId = window.setInterval(loadControlState, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [roomId]);

  useEffect(() => {
    if (browserPreviewRef.current) {
      browserPreviewRef.current.volume = browserVolume / 100;
    }
    if (browserRemoteVideoRef.current) {
      browserRemoteVideoRef.current.volume = browserVolume / 100;
    }
  }, [browserVolume]);

  useEffect(() => {
    if (!hasBrowserControl || isOwner) {
      setBrowserInteractionActive(false);
    }
  }, [hasBrowserControl, isOwner]);

  useEffect(() => {
    if (!browserInteractionActive) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (!browserStageRef.current?.contains(event.target)) {
        setBrowserInteractionActive(false);
        browserRemoteVideoRef.current?.blur();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [browserInteractionActive]);

  async function createRoom() {
    const cleanName = draftName.trim();
    if (!cleanName) {
      setError("Add your name first so your friends know who is hosting.");
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/api/rooms`, {
        method: "POST"
      });
      const data = await response.json();
      window.localStorage.setItem("watchparty-name", cleanName);
      setUsername(cleanName);
      setRoomId(data.roomId);
      setJoinRoomInput(data.roomId);
      setError("");
    } catch (_error) {
      setError("Could not create a room right now. Make sure the server is running.");
    }
  }

  function joinRoom() {
    const cleanName = draftName.trim();
    const cleanRoom = parseRoomInput(joinRoomInput);
    if (!cleanName || !cleanRoom) {
      setError("Enter your name and a room code or invitation link.");
      return;
    }

    window.localStorage.setItem("watchparty-name", cleanName);
    setUsername(cleanName);
    setRoomId(cleanRoom);
    setError("");
  }

  async function copyInviteLink() {
    if (!invitationLink) {
      return;
    }

    await navigator.clipboard.writeText(invitationLink);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function sendChatMessage(event) {
    event.preventDefault();
    if (!chatDraft.trim() || !socketRef.current) {
      return;
    }

    socketRef.current.emit("chat-message", {
      roomId,
      text: chatDraft
    });
    setChatDraft("");
  }

  async function syncBrowser(event) {
    event.preventDefault();
    if (!hasBrowserControl || !socketRef.current) {
      return;
    }

    const nextUrl = normalizeUrl(browserInput);
    if (!nextUrl) {
      return;
    }

    const nextState = {
      url: nextUrl,
      query: browserInput,
      status: desktopHost ? "desktop-webrtc" : "ready",
      aspectRatio: browserState.aspectRatio || 16 / 9
    };

    setBrowserWarning(desktopHost ? "" : getEmbedWarning(nextUrl));

    setBrowserState((current) => ({
      ...current,
      ...nextState,
      updatedAt: Date.now()
    }));

    if (isOwner && desktopHost) {
      socketRef.current.emit("browser-update", {
        roomId,
        ...nextState
      });
      await desktopHost.openHostBrowser();
      await desktopHost.navigateHostBrowser(nextUrl);
      await ensureDesktopBrowserStream(nextSocketOrCurrent());
      return;
    }

    if (hasBrowserControl) {
      socketRef.current.emit("browser-command", {
        roomId,
        command: "navigate",
        payload: {
          url: nextUrl
        }
      });
    }
  }

  async function openDesktopBrowser() {
    if (!desktopHost) {
      return;
    }

    await desktopHost.openHostBrowser();
    await ensureDesktopBrowserStream(nextSocketOrCurrent());
  }

  async function refreshDesktopBrowser() {
    if (!desktopHost) {
      return;
    }

    await desktopHost.refreshHostBrowser();
  }

  function requestBrowserControl() {
    const activeSocket = socketRef.current;
    const participantId = activeSocket?.id || selfId;
    if (!activeSocket || !participantId) {
      setControlNotice("Control request failed: socket-not-ready");
      return;
    }

    setControlRequests((current) => (current.includes(participantId) ? current : [...current, participantId]));
    activeSocket.emit("request-browser-control", { roomId }, (ack) => {
      if (!ack?.ok) {
        setControlNotice(`Control request failed: ${ack?.reason || "unknown"}`);
        setControlRequests((current) => current.filter((id) => id !== participantId));
        return;
      }

      setControlRequests(ack.controlRequests || []);
      setControllerId(ack.controllerId || null);
      setControlNotice("Control request sent.");
    });
  }

  function approveBrowserControl(requesterId) {
    const activeSocket = socketRef.current;
    if (!activeSocket) {
      setControlNotice("Could not approve control request: socket-not-ready");
      return;
    }

    activeSocket.emit(
      "approve-browser-control",
      {
        roomId,
        requesterId
      },
      (ack) => {
        if (!ack?.ok) {
          setControlNotice(`Could not approve control request: ${ack?.reason || "unknown"}`);
          return;
        }

        setControllerId(ack.controllerId || null);
        setControlRequests(ack.controlRequests || []);
        setControlNotice("Control approved.");
      }
    );
  }

  function denyBrowserControl(requesterId) {
    const activeSocket = socketRef.current;
    if (!activeSocket) {
      setControlNotice("Could not cancel control request: socket-not-ready");
      return;
    }

    activeSocket.emit(
      "deny-browser-control",
      {
        roomId,
        requesterId
      },
      (ack) => {
        if (!ack?.ok) {
          setControlNotice(`Could not cancel control request: ${ack?.reason || "unknown"}`);
          return;
        }

        setControllerId(ack.controllerId || null);
        setControlRequests(ack.controlRequests || []);
        setControlNotice("Control request cancelled.");
      }
    );
  }

  function releaseBrowserControl() {
    const activeSocket = socketRef.current;
    if (!activeSocket) {
      setControlNotice("Could not release control: socket-not-ready");
      return;
    }

    activeSocket.emit("release-browser-control", { roomId }, (ack) => {
      if (!ack?.ok) {
        setControlNotice(`Could not release control: ${ack?.reason || "unknown"}`);
        return;
      }

      setControllerId(ack.controllerId || null);
      setControlRequests(ack.controlRequests || []);
      setControlNotice("Control released.");
    });
  }

  function sendBrowserCommand(command) {
    if (!socketRef.current || !hasBrowserControl) {
      return;
    }

    if (isOwner && desktopHost) {
      if (command === "refresh") {
        desktopHost.refreshHostBrowser();
      } else if (command === "back") {
        desktopHost.goBackHostBrowser();
      } else if (command === "forward") {
        desktopHost.goForwardHostBrowser();
      }
      return;
    }

    socketRef.current.emit("browser-command", {
      roomId,
      command
    });
  }

  function relayBrowserPointer(type, event, extra = {}) {
    if (isOwner || !hasBrowserControl || !browserInteractionActive || !socketRef.current || !browserRemoteVideoRef.current) {
      return;
    }

    const videoElement = browserRemoteVideoRef.current;
    const rect = videoElement.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    const intrinsicWidth = videoElement.videoWidth || 0;
    const intrinsicHeight = videoElement.videoHeight || 0;

    let contentLeft = rect.left;
    let contentTop = rect.top;
    let contentWidth = rect.width;
    let contentHeight = rect.height;

    if (intrinsicWidth > 0 && intrinsicHeight > 0) {
      const elementAspect = rect.width / rect.height;
      const videoAspect = intrinsicWidth / intrinsicHeight;
      if (videoAspect > elementAspect) {
        contentHeight = rect.width / videoAspect;
        contentTop = rect.top + (rect.height - contentHeight) / 2;
      } else {
        contentWidth = rect.height * videoAspect;
        contentLeft = rect.left + (rect.width - contentWidth) / 2;
      }
    }

    const xWithinVideo = event.clientX - contentLeft;
    const yWithinVideo = event.clientY - contentTop;

    if (xWithinVideo < 0 || yWithinVideo < 0 || xWithinVideo > contentWidth || yWithinVideo > contentHeight) {
      return;
    }

    const xNorm = Math.max(0, Math.min(1, xWithinVideo / contentWidth));
    const yNorm = Math.max(0, Math.min(1, yWithinVideo / contentHeight));

    socketRef.current.emit("browser-command", {
      roomId,
      command: "mouse-event",
      payload: {
        type,
        xNorm,
        yNorm,
        ...extra
      }
    });
  }

  function relayBrowserKey(event) {
    if (isOwner || !hasBrowserControl || !browserInteractionActive || !socketRef.current) {
      return;
    }

    const blockedKeys = [
      "Tab",
      " ",
      "Spacebar",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "PageUp",
      "PageDown",
      "Home",
      "End",
      "Backspace"
    ];
    if (blockedKeys.includes(event.key)) {
      event.preventDefault();
    }
    event.stopPropagation();

    const modifiers = [];
    if (event.altKey) modifiers.push("alt");
    if (event.ctrlKey) modifiers.push("control");
    if (event.metaKey) modifiers.push("meta");
    if (event.shiftKey) modifiers.push("shift");

    socketRef.current.emit("browser-command", {
      roomId,
      command: "key-event",
      payload: {
        type: event.type === "keydown" ? "keyDown" : "keyUp",
        key: event.key,
        modifiers
      }
    });

    if (event.type === "keydown" && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      socketRef.current.emit("browser-command", {
        roomId,
        command: "key-event",
        payload: {
          type: "char",
          key: event.key
        }
      });
    }
  }

  function nextSocketOrCurrent() {
    return socketRef.current;
  }

  async function ensureDesktopBrowserStream(activeSocket = socketRef.current) {
    if (!desktopHost) {
      return false;
    }

    if (browserStreamRef.current) {
      return true;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: {
            ideal: STREAM_QUALITY_PRESETS.sharp.fps,
            max: STREAM_QUALITY_PRESETS.sharp.fps
          },
          width: {
            ideal: STREAM_QUALITY_PRESETS.sharp.width,
            max: STREAM_QUALITY_PRESETS.sharp.width
          },
          height: {
            ideal: STREAM_QUALITY_PRESETS.sharp.height,
            max: STREAM_QUALITY_PRESETS.sharp.height
          }
        },
        audio: true
      });

      browserStreamRef.current = stream;
      setBrowserStreamReady(true);
      setDesktopBrowserState((current) => ({
        ...current,
        isStreaming: true
      }));
      setBrowserState((current) => ({
        ...current,
        status: "desktop-webrtc",
        updatedAt: Date.now()
      }));

      if (browserPreviewRef.current) {
        browserPreviewRef.current.srcObject = stream;
        browserPreviewRef.current.play().catch(() => {});
      }

      const [videoTrack] = stream.getVideoTracks();
      if (videoTrack) {
        videoTrack.contentHint = "detail";
        const settings = videoTrack.getSettings();
        setBrowserState((current) => ({
          ...current,
          aspectRatio:
            settings.aspectRatio ||
            (settings.width && settings.height ? settings.width / settings.height : current.aspectRatio),
          updatedAt: Date.now()
        }));

        videoTrack.addEventListener("ended", () => {
          stopDesktopBrowserStream();
        });
      }

      socketRef.current?.emit("browser-update", {
        roomId: roomIdRef.current,
        url: desktopBrowserState.url || browserState.url || browserInput,
        query: browserInput,
        status: "desktop-webrtc",
        aspectRatio:
          videoTrack?.getSettings().aspectRatio ||
          (videoTrack?.getSettings().width && videoTrack?.getSettings().height
            ? videoTrack.getSettings().width / videoTrack.getSettings().height
            : browserState.aspectRatio || 16 / 9)
      });

      const others = participants.filter((participant) => participant.id !== activeSocket?.id);
      for (const participant of others) {
        await createBrowserOfferForParticipant(participant.id, activeSocket);
      }

      return true;
    } catch (streamError) {
      console.error(streamError);
      setError("Could not start the live browser stream.");
      return false;
    }
  }

  function stopDesktopBrowserStream() {
    if (browserStreamRef.current) {
      browserStreamRef.current.getTracks().forEach((track) => track.stop());
      browserStreamRef.current = null;
    }

    if (browserPreviewRef.current) {
      browserPreviewRef.current.srcObject = null;
    }

    browserRemoteStreamRef.current = null;
    browserPeersRef.current.forEach((_, participantId) => removeBrowserPeer(participantId));
    setBrowserStreamReady(false);
    setBrowserRemoteReady(false);
    setDesktopBrowserState((current) => ({
      ...current,
      isStreaming: false
    }));
  }

  async function toggleBrowserFullscreen() {
    if (!browserStageRef.current) {
      return;
    }

    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    await browserStageRef.current.requestFullscreen();
  }

  async function toggleTheaterMode() {
    const nextValue = !theaterMode;
    setTheaterMode(nextValue);

    if (!roomPageRef.current) {
      return;
    }

    try {
      if (nextValue && !document.fullscreenElement) {
        await roomPageRef.current.requestFullscreen();
      } else if (!nextValue && document.fullscreenElement === roomPageRef.current) {
        await document.exitFullscreen();
      }
    } catch (_error) {
      // Ignore fullscreen failures and still keep theater layout enabled.
    }
  }

  async function toggleScreenShare() {
    if (!localStreamRef.current) {
      return;
    }

    if (sharingScreen) {
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      swapOutgoingTracks(cameraStream);
      setSharingScreen(false);
      return;
    }

    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });

    displayStream.getVideoTracks()[0].addEventListener("ended", async () => {
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      swapOutgoingTracks(cameraStream);
      setSharingScreen(false);
    });

    swapOutgoingTracks(displayStream);
    setSharingScreen(true);
  }

  function swapOutgoingTracks(nextStream) {
    const previousStream = localStreamRef.current;
    localStreamRef.current = nextStream;

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = nextStream;
    }

    const senders = [];
    peersRef.current.forEach(({ connection }) => {
      connection.getSenders().forEach((sender) => senders.push(sender));
    });

    nextStream.getTracks().forEach((track) => {
      const sender = senders.find((item) => item.track && item.track.kind === track.kind);
      if (sender) {
        sender.replaceTrack(track);
      }
    });

    if (previousStream) {
      previousStream.getTracks().forEach((track) => {
        if (track.readyState === "live") {
          track.stop();
        }
      });
    }

    setCameraEnabled(nextStream.getVideoTracks().some((track) => track.enabled));
    setMicEnabled(nextStream.getAudioTracks().some((track) => track.enabled));
  }

  function toggleTrack(kind) {
    const stream = localStreamRef.current;
    if (!stream) {
      return;
    }

    const tracks = kind === "video" ? stream.getVideoTracks() : stream.getAudioTracks();
    tracks.forEach((track) => {
      track.enabled = !track.enabled;
    });

    if (kind === "video") {
      setCameraEnabled(tracks.some((track) => track.enabled));
    } else {
      setMicEnabled(tracks.some((track) => track.enabled));
    }
  }

  async function createOfferForParticipant(participantId, activeSocket = socketRef.current) {
    if (!activeSocket || peersRef.current.has(participantId)) {
      return;
    }

    const connection = buildPeerConnection(participantId, activeSocket);
    peersRef.current.set(participantId, { connection });

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);

    activeSocket.emit("webrtc-signal", {
      roomId,
      targetId: participantId,
      signal: {
        type: "offer",
        sdp: offer.sdp
      }
    });
  }

  function buildPeerConnection(participantId, activeSocket) {
    const connection = new RTCPeerConnection(rtcConfig);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        connection.addTrack(track, localStreamRef.current);
      });
    }

    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      activeSocket.emit("webrtc-signal", {
        roomId,
        targetId: participantId,
        signal: {
          type: "ice-candidate",
          candidate: event.candidate
        }
      });
    };

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      const video = remoteVideoRefs.current.get(participantId);
      if (video) {
        video.srcObject = stream;
      }
    };

    connection.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(connection.connectionState)) {
        removePeer(participantId);
      }
    };

    return connection;
  }

  async function handleSignal(senderId, signal, activeSocket = socketRef.current) {
    if (!activeSocket) {
      return;
    }

    let peer = peersRef.current.get(senderId);
    if (!peer) {
      const connection = buildPeerConnection(senderId, activeSocket);
      peer = { connection };
      peersRef.current.set(senderId, peer);
    }

    const { connection } = peer;

    if (signal.type === "offer") {
      await connection.setRemoteDescription(new RTCSessionDescription(signal));
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);

      activeSocket.emit("webrtc-signal", {
        roomId,
        targetId: senderId,
        signal: {
          type: "answer",
          sdp: answer.sdp
        }
      });
      return;
    }

    if (signal.type === "answer") {
      await connection.setRemoteDescription(new RTCSessionDescription(signal));
      return;
    }

    if (signal.type === "ice-candidate" && signal.candidate) {
      await connection.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  }

  function removePeer(participantId) {
    const peer = peersRef.current.get(participantId);
    if (!peer) {
      return;
    }

    peer.connection.close();
    peersRef.current.delete(participantId);

    const video = remoteVideoRefs.current.get(participantId);
    if (video) {
      video.srcObject = null;
    }
  }

  async function createBrowserOfferForParticipant(participantId, activeSocket = socketRef.current) {
    if (!activeSocket || !browserStreamRef.current || browserPeersRef.current.has(participantId)) {
      return;
    }

    const connection = buildBrowserPeerConnection(participantId, activeSocket);
    browserPeersRef.current.set(participantId, { connection });

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);

    activeSocket.emit("webrtc-signal", {
      roomId,
      targetId: participantId,
      signal: {
        channel: "browser",
        type: "offer",
        sdp: offer.sdp
      }
    });
  }

  function buildBrowserPeerConnection(participantId, activeSocket) {
    const connection = new RTCPeerConnection(rtcConfig);

    if (browserStreamRef.current) {
      browserStreamRef.current.getTracks().forEach((track) => {
        const sender = connection.addTrack(track, browserStreamRef.current);
        if (track.kind === "video") {
          const requestedQuality = requestedBrowserQualityRef.current.get(participantId) || "sharp";
          tuneBrowserSender(sender, requestedQuality);
        }
      });
    }

    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      activeSocket.emit("webrtc-signal", {
        roomId,
        targetId: participantId,
        signal: {
          channel: "browser",
          type: "ice-candidate",
          candidate: event.candidate
        }
      });
    };

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      browserRemoteStreamRef.current = stream;
      setBrowserRemoteReady(true);
      setBrowserState((current) => ({
        ...current,
        status: "desktop-webrtc",
        updatedAt: Date.now()
      }));

      if (browserRemoteVideoRef.current) {
        browserRemoteVideoRef.current.srcObject = stream;
        browserRemoteVideoRef.current.play().catch(() => {});
      }
    };

    connection.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(connection.connectionState)) {
        removeBrowserPeer(participantId);
      }
    };

    return connection;
  }

  async function handleBrowserSignal(senderId, signal, activeSocket = socketRef.current) {
    if (!activeSocket) {
      return;
    }

    let peer = browserPeersRef.current.get(senderId);
    if (!peer) {
      const connection = buildBrowserPeerConnection(senderId, activeSocket);
      peer = { connection };
      browserPeersRef.current.set(senderId, peer);
    }

    const { connection } = peer;

    if (signal.type === "offer") {
      await connection.setRemoteDescription(new RTCSessionDescription(signal));
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);

      activeSocket.emit("webrtc-signal", {
        roomId,
        targetId: senderId,
        signal: {
          channel: "browser",
          type: "answer",
          sdp: answer.sdp
        }
      });
      return;
    }

    if (signal.type === "answer") {
      await connection.setRemoteDescription(new RTCSessionDescription(signal));
      return;
    }

    if (signal.type === "ice-candidate" && signal.candidate) {
      await connection.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  }

  function removeBrowserPeer(participantId) {
    const peer = browserPeersRef.current.get(participantId);
    if (!peer) {
      return;
    }

    peer.connection.close();
    browserPeersRef.current.delete(participantId);
  }

  if (!roomId || !username) {
    return (
      <div className="page-shell">
        <div className="ambient ambient-left" />
        <div className="ambient ambient-right" />
        <section className="hero-card">
          <span className="eyebrow">Realtime movie rooms</span>
          <h1>RoomFlix lets your group browse, chat, and jump on video in one watch-party room.</h1>
          <p className="hero-copy">
            Create a room, invite friends, then control the shared browser as host. When a streaming site blocks embeds,
            switch to screen share inside the same room.
          </p>

          <div className="form-grid">
            <label className="input-block">
              <span>Your name</span>
              <input
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="Ankit"
              />
            </label>

            <div className="cta-row">
              <button className="primary-btn" onClick={createRoom}>
                Create Room
              </button>
            </div>

            <label className="input-block">
              <span>Join with room code</span>
              <input
                value={joinRoomInput}
                onChange={(event) => setJoinRoomInput(event.target.value)}
                placeholder="ABC123"
              />
            </label>

            <div className="cta-row">
              <button className="secondary-btn" onClick={joinRoom}>
                Join Room
              </button>
            </div>
          </div>

          {error ? <p className="error-text">{error}</p> : null}

          <div className="feature-strip">
            <div>
              <strong>Shared browsing</strong>
              <span>Host controls synced navigation for everyone.</span>
            </div>
            <div>
              <strong>Live chat</strong>
              <span>Quick reactions without leaving the room.</span>
            </div>
            <div>
              <strong>Video panel</strong>
              <span>WebRTC camera, mic, and screen share controls.</span>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div ref={roomPageRef} className={`room-page ${theaterMode ? "theater-mode" : ""}`}>
      <header className="room-topbar">
        <div>
          <span className="eyebrow">Room {roomId}</span>
          <h2>Watch together without tab-hopping.</h2>
        </div>

        <div className="topbar-actions">
          <div className="invite-box">
            <span>{invitationLink}</span>
          </div>
          <button className="secondary-btn" onClick={copyInviteLink}>
            {copied ? "Copied" : "Copy Invite"}
          </button>
        </div>
      </header>

      <main className="room-layout">
        <section className="browser-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Shared browser</span>
              <h3>{isOwner ? "You control the room browser" : "Following host navigation"}</h3>
            </div>
            <div className="panel-status-row">
              {controllerDisplayName ? <div className="control-pill">Control: {controllerDisplayName}</div> : null}
              <div className="presence-pill">{peopleCountLabel}</div>
            </div>
          </div>

          <form className="browser-form" onSubmit={syncBrowser}>
            <input
              value={browserInput}
              onChange={(event) => setBrowserInput(event.target.value)}
              placeholder="Paste a URL or search for a movie"
              disabled={!hasBrowserControl}
            />
            <button className="primary-btn" type="submit" disabled={!hasBrowserControl}>
              {hasBrowserControl ? "Open Page" : "Host Only"}
            </button>
          </form>

          <div className="desktop-actions">
            {!isOwner && !hasBrowserControl ? (
              <button className="secondary-btn" type="button" onClick={requestBrowserControl}>
                {controlRequests.includes(selfId) ? "Request Pending" : "Request Control"}
              </button>
            ) : null}
            {!isOwner && hasBrowserControl ? (
              <button className="secondary-btn" type="button" onClick={releaseBrowserControl}>
                Release Control
              </button>
            ) : null}
            {!isOwner && hasBrowserControl ? (
              <>
                <button className="secondary-btn" type="button" onClick={() => sendBrowserCommand("back")}>
                  Back
                </button>
                <button className="secondary-btn" type="button" onClick={() => sendBrowserCommand("forward")}>
                  Forward
                </button>
                <button className="secondary-btn" type="button" onClick={() => sendBrowserCommand("refresh")}>
                  Refresh
                </button>
              </>
            ) : null}
          </div>

          {controlNotice ? <div className="control-request-empty">{controlNotice}</div> : null}

          {isOwner ? (
            <div className="control-request-panel">
              <div className="control-request-head">
                <strong>Browser Control</strong>
                <span>
                  {controllerId
                    ? `${participants.find((participant) => participant.id === controllerId)?.username || "Someone"} is controlling`
                    : pendingRequestCount > 0
                      ? `${pendingRequestCount} pending`
                      : "Host only"}
                </span>
              </div>

              {controlRequests.length > 0 ? (
                <div className="control-request-list">
                  {controlRequests.map((requesterId) => {
                    const requester = participants.find((participant) => participant.id === requesterId);
                    if (!requester) {
                      return null;
                    }

                    return (
                      <div className="control-request-item" key={requesterId}>
                        <span>{requester.username} requested control</span>
                        <div className="control-request-actions">
                          <button className="mini-btn" type="button" onClick={() => approveBrowserControl(requesterId)}>
                            Approve
                          </button>
                          <button className="mini-btn cancel" type="button" onClick={() => denyBrowserControl(requesterId)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="control-request-empty">No pending control requests.</div>
              )}

              {controllerId ? (
                <button className="secondary-btn" type="button" onClick={releaseBrowserControl}>
                  Take Back Control
                </button>
              ) : null}
            </div>
          ) : null}

          {desktopHost && isOwner ? (
            <div className="desktop-actions">
              <button className="secondary-btn" onClick={openDesktopBrowser}>
                {desktopBrowserState.isOpen ? "Focus Desktop Browser" : "Open Desktop Browser"}
              </button>
              <button className="secondary-btn" onClick={refreshDesktopBrowser} disabled={!desktopBrowserState.isOpen}>
                Refresh Host Browser
              </button>
              <button className="primary-btn" onClick={() => (browserStreamReady ? stopDesktopBrowserStream() : ensureDesktopBrowserStream())}>
                {browserStreamReady ? "Stop Live Stream" : "Start Live Stream"}
              </button>
            </div>
          ) : null}

          <div className="browser-meta">
            <span>Current page: {browserState.url || desktopBrowserState.url || "Waiting for host"}</span>
            <span>Last update: {browserState.updatedAt ? formatTime(browserState.updatedAt) : "--:--"}</span>
          </div>

          {desktopHost && isOwner ? (
            <div className="desktop-debug">
              <span>{browserStreamReady ? "Desktop browser live stream active" : "Desktop browser live stream idle"}</span>
              <span>Socket: {socketRef.current?.connected ? "connected" : "not connected"}</span>
              <span>Role: host</span>
            </div>
          ) : null}

          <div
            ref={browserStageRef}
            className={`browser-frame-wrap ${browserState.status?.startsWith("desktop-") ? "desktop-mode" : ""}`}
            style={
              browserState.status?.startsWith("desktop-")
                ? { "--browser-aspect-ratio": String(browserState.aspectRatio || 16 / 9) }
                : undefined
            }
          >
            {theaterMode ? (
              <button className="theater-exit-btn" type="button" onClick={toggleTheaterMode}>
                Exit Theater
              </button>
            ) : null}

            {desktopHost && isOwner && browserStreamReady ? (
              <video ref={browserPreviewRef} className="browser-stream-image" autoPlay muted playsInline />
            ) : browserState.status?.startsWith("desktop-") && browserRemoteReady ? (
              <video
                ref={browserRemoteVideoRef}
                tabIndex={hasBrowserControl && !isOwner ? 0 : -1}
                className={`browser-stream-image ${hasBrowserControl && !isOwner ? "interactive-stream" : ""} ${
                  browserInteractionActive ? "interaction-active" : ""
                }`}
                autoPlay
                playsInline
                onClick={(event) => {
                  if (hasBrowserControl && !isOwner) {
                    event.stopPropagation();
                    setBrowserInteractionActive(true);
                    browserRemoteVideoRef.current?.focus();
                  }
                }}
                onMouseMove={(event) => relayBrowserPointer("mouseMove", event)}
                onMouseDown={(event) => {
                  if (hasBrowserControl && !isOwner) {
                    event.stopPropagation();
                    setBrowserInteractionActive(true);
                    browserRemoteVideoRef.current?.focus();
                  }
                  relayBrowserPointer("mouseDown", event, {
                    button: event.button === 2 ? "right" : "left"
                  });
                }}
                onMouseUp={(event) =>
                  relayBrowserPointer("mouseUp", event, {
                    button: event.button === 2 ? "right" : "left"
                  })
                }
                onDoubleClick={(event) =>
                  relayBrowserPointer("mouseDown", event, {
                    button: "left",
                    clickCount: 2
                  })
                }
                onWheel={(event) => {
                  if (!browserInteractionActive) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  relayBrowserPointer("wheel", event, {
                    deltaX: event.deltaX,
                    deltaY: -event.deltaY
                  });
                }}
                onKeyDown={(event) => relayBrowserKey(event)}
                onKeyUp={(event) => relayBrowserKey(event)}
              />
            ) : browserState.status?.startsWith("desktop-") ? (
              <div className="browser-placeholder">
                <p>Waiting for the host browser live stream...</p>
              </div>
            ) : browserState.url ? (
              <iframe title="Shared browser" src={browserState.url} className="browser-frame" />
            ) : (
              <div className="browser-placeholder">
                <p>The host hasn&apos;t loaded a page yet.</p>
              </div>
            )}

          </div>

          <div className="player-controls">
            <label className="player-volume">
              <span>Volume</span>
              <input
                type="range"
                min="0"
                max="100"
                value={browserVolume}
                onChange={(event) => setBrowserVolume(Number(event.target.value))}
              />
            </label>

            {!isOwner ? (
              <label className="input-block stream-quality-block">
                <span>Playback quality</span>
                <select value={receiverQuality} onChange={(event) => setReceiverQuality(event.target.value)}>
                  {Object.entries(STREAM_QUALITY_PRESETS).map(([key, preset]) => (
                    <option key={key} value={key}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <button className="secondary-btn" onClick={toggleTheaterMode}>
              {theaterMode ? "Exit Theater" : "Theater Mode"}
            </button>

            <button className="secondary-btn" onClick={toggleBrowserFullscreen}>
              Full Screen
            </button>
          </div>

          {!browserState.status?.startsWith("desktop-") && browserWarning ? (
            <div className="browser-note standalone-note">{browserWarning}</div>
          ) : null}
        </section>

        <aside className="sidebar">
          <section className="panel sidebar-tabs-panel">
            <div className="sidebar-tabs">
              <button
                className={`sidebar-tab ${sidebarTab === "call" ? "active" : ""}`}
                onClick={() => setSidebarTab("call")}
              >
                <span>Call</span>
                <span className="tab-badge">{othersInCallCount}</span>
              </button>
              <button
                className={`sidebar-tab ${sidebarTab === "people" ? "active" : ""}`}
                onClick={() => setSidebarTab("people")}
              >
                <span>People</span>
                <span className="tab-badge">{participants.length}</span>
              </button>
              <button
                className={`sidebar-tab ${sidebarTab === "chat" ? "active" : ""}`}
                onClick={() => setSidebarTab("chat")}
              >
                <span>Chat</span>
                {unreadChatCount > 0 ? <span className="tab-badge alert">{unreadChatCount}</span> : null}
              </button>
            </div>

            {sidebarTab === "people" ? (
              <section className="tab-panel participants-panel">
                <div className="panel-head compact">
                  <div>
                    <span className="eyebrow">People</span>
                    <h3>Room members</h3>
                  </div>
                  <div className="presence-pill">{peopleCountLabel}</div>
                </div>

                {controllerDisplayName ? <div className="controller-banner">Current control: {controllerDisplayName}</div> : null}

                <div className="participant-list">
                  {participants.map((participant) => (
                    <div className="participant-card" key={participant.id}>
                      <div>
                        <strong>{participant.username}</strong>
                        <span>
                          {participant.id === ownerId
                            ? "Host"
                            : participant.id === controllerId
                              ? "Controller"
                              : "Guest"}
                        </span>
                      </div>
                      <div className="participant-actions">
                        {isOwner && controlRequests.includes(participant.id) ? (
                          <button className="mini-btn" onClick={() => approveBrowserControl(participant.id)}>
                            Approve
                          </button>
                        ) : null}
                        <span className={`status-dot ${participant.id === selfId ? "self" : ""}`} />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {sidebarTab === "call" ? (
              <section className="tab-panel call-panel">
                <div className="panel-head compact">
                  <div>
                    <span className="eyebrow">Call</span>
                    <h3>Video column</h3>
                  </div>
                </div>

                <div className="video-grid">
                  <div className="video-tile">
                    <video ref={localVideoRef} autoPlay muted playsInline />
                    <div className="video-label">You</div>
                  </div>

                  {participants
                    .filter((participant) => participant.id !== selfId)
                    .map((participant) => (
                      <div className="video-tile" key={participant.id}>
                        <video
                          id={`remote-video-${participant.id}`}
                          ref={(node) => {
                            if (node) {
                              remoteVideoRefs.current.set(participant.id, node);
                            } else {
                              remoteVideoRefs.current.delete(participant.id);
                            }
                          }}
                          autoPlay
                          playsInline
                        />
                        <div className="video-label">{participant.username}</div>
                      </div>
                    ))}
                </div>

                <div className="control-row">
                  <button className="secondary-btn" onClick={() => toggleTrack("video")}>
                    {cameraEnabled ? "Camera Off" : "Camera On"}
                  </button>
                  <button className="secondary-btn" onClick={() => toggleTrack("audio")}>
                    {micEnabled ? "Mute" : "Unmute"}
                  </button>
                  <button className="primary-btn" onClick={toggleScreenShare}>
                    {sharingScreen ? "Stop Share" : "Share Screen"}
                  </button>
                </div>
              </section>
            ) : null}

            {sidebarTab === "chat" ? (
              <section className="tab-panel chat-panel">
                <div className="panel-head compact">
                  <div>
                    <span className="eyebrow">Chat</span>
                    <h3>Room messages</h3>
                  </div>
                </div>

                <div className="chat-stream">
                  {messages.map((message) => (
                    <div className="chat-bubble" key={message.id}>
                      <div className="chat-meta">
                        <strong>{message.senderName}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <p>{message.text}</p>
                    </div>
                  ))}
                </div>

                <form className="chat-form" onSubmit={sendChatMessage}>
                  <input
                    value={chatDraft}
                    onChange={(event) => setChatDraft(event.target.value)}
                    placeholder="Type a message"
                  />
                  <button className="primary-btn" type="submit">
                    Send
                  </button>
                </form>
              </section>
            ) : null}
          </section>
        </aside>
      </main>
    </div>
  );
}

export default App;
