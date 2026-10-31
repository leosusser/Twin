function smoothAudioLevel(previous, next, attack = 0.35, release = 0.12) {
  const amount = next > previous ? attack : release;
  return previous + (next - previous) * amount;
}

function rmsAudioLevel(bytes) {
  if (!bytes?.length) return 0;
  let sum = 0;
  for (const value of bytes) {
    const sample = (value - 128) / 128;
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / bytes.length) * 3.2);
}

function completedTranscript(event) {
  if (event?.type === "conversation.item.input_audio_transcription.completed")
    return {
      provider_item_id: event.item_id,
      role: "user",
      transcript: event.transcript,
      completed_at: new Date().toISOString(),
    };
  if (
    event?.type === "response.output_audio_transcript.done" ||
    event?.type === "response.audio_transcript.done"
  )
    return {
      provider_item_id: event.item_id,
      role: "assistant",
      transcript: event.transcript,
      completed_at: new Date().toISOString(),
    };
  return null;
}

class VoiceTalkController {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.state = "idle";
    this.items = new Map();
    this.pendingResponses = new Set();
    this.pendingInputTranscriptions = new Set();
    this.hasUncommittedInput = false;
    this.inputLevel = 0;
    this.outputLevel = 0;
    this.muted = false;
    this.drainTimeoutMs = callbacks.drainTimeoutMs ?? 15000;
    this.drainQuietMs = callbacks.drainQuietMs ?? 800;
    this.drainPollMs = callbacks.drainPollMs ?? 50;
  }

  setState(state, message = "") {
    this.state = state;
    this.callbacks.onState?.({ state, message, muted: this.muted });
  }

  prepareMicrophone() {
    if (this.microphonePromise) return this.microphonePromise;
    const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!globalThis.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia || !AudioContext) {
      const error = new Error("Voice Talk needs a browser with microphone and WebRTC support.");
      error.code = "VOICE_BROWSER_UNSUPPORTED";
      this.setState("error", error.message);
      return Promise.reject(error);
    }
    this.inputContext = new AudioContext();
    this.outputContext = new AudioContext();
    this.inputContext.resume().catch(() => {});
    this.outputContext.resume().catch(() => {});
    this.setState("permission", "Waiting for microphone permission…");
    this.microphonePromise = navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      .catch((error) => {
        this.teardown(false);
        const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
        const problem = new Error(
          denied
            ? "Microphone access was blocked. Allow it in your browser, then retry."
            : "Twin could not open your microphone. Check the selected input device.",
        );
        problem.code = denied ? "MICROPHONE_DENIED" : "MICROPHONE_UNAVAILABLE";
        this.setState("error", problem.message);
        throw problem;
      });
    return this.microphonePromise;
  }

  async start(conversationId) {
    if (["connecting", "listening", "user_speaking", "twin_speaking", "muted"].includes(this.state))
      return;
    this.conversationId = conversationId;
    this.items.clear();
    this.muted = false;
    let startRequestBegan = false;
    let startResolutionKnown = false;
    try {
      if (this.recoverableActiveSession?.conversationId === conversationId) {
        await this.abandonRecoveredSession(
          conversationId,
          this.recoverableActiveSession.voiceSessionId,
        );
        this.recoverableActiveSession = null;
      }
      const stream = await this.prepareMicrophone();
      this.localStream = stream;
      this.setState("connecting", "Connecting securely…");
      const peer = new RTCPeerConnection();
      this.peer = peer;
      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      channel.addEventListener("message", (event) => this.handleProviderEvent(event.data));
      channel.addEventListener("open", () => this.setState(this.muted ? "muted" : "listening"));
      channel.addEventListener("error", () => this.fail("The voice event connection failed."));
      peer.addEventListener("connectionstatechange", () => {
        if (["failed", "disconnected"].includes(peer.connectionState))
          this.fail("The voice connection was interrupted. Retry when you are ready.");
      });
      peer.addEventListener("track", (event) => {
        const remote = event.streams[0] ?? new MediaStream([event.track]);
        this.attachRemoteAudio(remote);
      });
      this.attachInputAnalyser(stream);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const startKey = (this.startIdempotencyKey ??= crypto.randomUUID());
      const recoveryAttempt = this.retainStartIdempotencyKey === true;
      startRequestBegan = true;
      const response = await fetch(
        `/api/talk/conversations/${encodeURIComponent(conversationId)}/voice-calls`,
        {
          method: "POST",
          headers: {
            "content-type": "application/sdp",
            "idempotency-key": startKey,
          },
          body: offer.sdp,
        },
      );
      const answer = await response.text();
      startResolutionKnown = true;
      if (!response.ok) {
        let message = "Twin could not start voice Talk.";
        let payload = {};
        try {
          payload = JSON.parse(answer);
          message = payload.message ?? message;
        } catch {}
        if (
          payload.code === "VOICE_CALL_ALREADY_STARTED" &&
          recoveryAttempt &&
          this.startIdempotencyKey === startKey &&
          typeof payload.voice_session_id === "string"
        ) {
          await this.abandonRecoveredSession(conversationId, payload.voice_session_id);
          this.startIdempotencyKey = null;
          this.retainStartIdempotencyKey = false;
          message = "Twin safely closed the previous voice connection. Press Retry to reconnect.";
        } else {
          this.startIdempotencyKey = null;
          this.retainStartIdempotencyKey = false;
          if (
            payload.code === "VOICE_CALL_ACTIVE" &&
            typeof payload.voice_session_id === "string"
          ) {
            this.recoverableActiveSession = {
              conversationId,
              voiceSessionId: payload.voice_session_id,
            };
            message =
              "A previous Voice Talk session is still marked active. Press Retry to end it and reconnect here. If another tab is actually using voice, Retry will end that call.";
          }
        }
        throw new Error(message);
      }
      this.voiceSessionId = response.headers.get("x-twin-voice-session");
      if (!this.voiceSessionId) throw new Error("Twin did not return a voice session.");
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
      this.recoverableActiveSession = null;
      this.startIdempotencyKey = null;
      this.retainStartIdempotencyKey = false;
      this.startMeter();
    } catch (error) {
      if (startRequestBegan && !startResolutionKnown) this.retainStartIdempotencyKey = true;
      const message = error?.message ?? "Twin could not start voice Talk.";
      if (this.voiceSessionId) {
        try {
          await this.abandon(message);
        } catch {}
      }
      else this.cancelPrepared(message);
      throw error;
    }
  }

  attachRemoteAudio(stream) {
    this.remoteStream = stream;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.hidden = true;
    audio.srcObject = stream;
    document.body.append(audio);
    this.remoteAudio = audio;
    const source = this.outputContext.createMediaElementSource(audio);
    this.outputAnalyser = this.outputContext.createAnalyser();
    this.outputAnalyser.fftSize = 512;
    source.connect(this.outputAnalyser);
    this.outputAnalyser.connect(this.outputContext.destination);
    this.outputContext.resume().catch(() => {});
    audio.play().catch(() => {});
  }

  attachInputAnalyser(stream) {
    const source = this.inputContext.createMediaStreamSource(stream);
    this.inputAnalyser = this.inputContext.createAnalyser();
    this.inputAnalyser.fftSize = 512;
    source.connect(this.inputAnalyser);
    this.inputContext.resume().catch(() => {});
  }

  startMeter() {
    globalThis.cancelAnimationFrame?.(this.meterFrame);
    let inputBytes = null;
    let outputBytes = null;
    let inputAnalyser = null;
    let outputAnalyser = null;
    const tick = () => {
      if (!this.peer) return;
      if (this.inputAnalyser !== inputAnalyser) {
        inputAnalyser = this.inputAnalyser;
        inputBytes = inputAnalyser ? new Uint8Array(inputAnalyser.fftSize) : null;
      }
      if (this.outputAnalyser !== outputAnalyser) {
        outputAnalyser = this.outputAnalyser;
        outputBytes = outputAnalyser ? new Uint8Array(outputAnalyser.fftSize) : null;
      }
      if (inputBytes) inputAnalyser.getByteTimeDomainData(inputBytes);
      if (outputBytes) outputAnalyser.getByteTimeDomainData(outputBytes);
      const nextInput = this.muted ? 0 : rmsAudioLevel(inputBytes);
      const nextOutput = rmsAudioLevel(outputBytes);
      this.inputLevel = smoothAudioLevel(this.inputLevel, nextInput);
      this.outputLevel = smoothAudioLevel(this.outputLevel, nextOutput);
      const now = Date.now();
      if (nextInput > 0.06) {
        this.lastInputActiveAt = now;
        this.hasUncommittedInput = true;
      }
      if (nextOutput > 0.035) this.lastAudibleAt = now;
      const activeState = this.outputLevel > 0.045
        ? "twin_speaking"
        : this.muted
          ? "muted"
          : this.inputLevel > 0.06
            ? "user_speaking"
            : "listening";
      if (!["connecting", "permission", "error", "ended"].includes(this.state) && activeState !== this.state)
        this.setState(activeState);
      this.callbacks.onLevels?.({ input: this.inputLevel, output: this.outputLevel });
      this.meterFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  handleProviderEvent(raw) {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const responseId = event?.response?.id ?? event?.response_id;
    const providerItemId = event?.item_id;
    if (event?.type === "input_audio_buffer.speech_started") this.hasUncommittedInput = true;
    if (event?.type === "response.created" && typeof responseId === "string")
      this.pendingResponses.add(responseId);
    if (event?.type === "response.done" && typeof responseId === "string")
      this.pendingResponses.delete(responseId);
    if (event?.type === "input_audio_buffer.committed") {
      this.awaitingCommitAcknowledgement = false;
      this.hasUncommittedInput = false;
      if (typeof providerItemId === "string") this.pendingInputTranscriptions.add(providerItemId);
    }
    if (
      (event?.type === "conversation.item.input_audio_transcription.completed" ||
        event?.type === "conversation.item.input_audio_transcription.failed") &&
      typeof providerItemId === "string"
    ) {
      this.awaitingCommitAcknowledgement = false;
      this.pendingInputTranscriptions.delete(providerItemId);
    }
    if (event?.type === "error" && event?.error?.event_id === this.pendingCommitEventId) {
      this.awaitingCommitAcknowledgement = false;
      if (/empty|too small/i.test(`${event?.error?.code ?? ""} ${event?.error?.message ?? ""}`))
        this.hasUncommittedInput = false;
    }
    if (
      event?.type === "input_audio_buffer.speech_started" ||
      event?.type === "input_audio_buffer.speech_stopped" ||
      event?.type === "input_audio_buffer.committed" ||
      event?.type === "conversation.item.input_audio_transcription.completed" ||
      event?.type === "conversation.item.input_audio_transcription.failed" ||
      event?.type === "response.output_audio_transcript.done" ||
      event?.type === "response.audio_transcript.done" ||
      event?.type === "response.created" ||
      event?.type === "response.done"
    )
      this.lastProviderActivityAt = Date.now();
    const item = completedTranscript(event);
    if (
      item?.provider_item_id &&
      typeof item.transcript === "string" &&
      item.transcript.trim() &&
      !this.items.has(item.provider_item_id)
    ) {
      item.transcript = item.transcript.trim().slice(0, 3000);
      this.items.set(item.provider_item_id, item);
      this.callbacks.onTranscript?.([...this.items.values()]);
    }
    if (event?.type === "error" && !this.closingPromise)
      void this.fail("OpenAI reported a voice-session problem. Retry Talk.");
  }

  toggleMute() {
    if (!this.localStream) return;
    this.muted = !this.muted;
    for (const track of this.localStream.getAudioTracks()) track.enabled = !this.muted;
    this.setState(this.muted ? "muted" : "listening");
  }

  async end() {
    if (this.closingPromise) return this.closingPromise;
    this.closingPromise = this.closeAndPersist("complete");
    try {
      return await this.closingPromise;
    } finally {
      this.closingPromise = null;
    }
  }

  async closeAndPersist(disposition, options = {}) {
    const hasSession = Boolean(this.voiceSessionId && this.conversationId);
    for (const track of this.localStream?.getAudioTracks?.() ?? []) track.enabled = false;
    if (disposition === "complete") this.setState("ended", "Finishing and saving…");
    if (hasSession && !options.skipDrain)
      await this.requestProviderDrain(
        options.drainMs ?? this.drainTimeoutMs,
        options.quietMs ?? this.drainQuietMs,
        options.pollMs ?? this.drainPollMs,
      );
    const items = [...this.items.values()];
    this.teardown(true);
    if (!hasSession) return null;
    this.needsCloseRetry = true;
    try {
      const result = await this.persistClose(items, disposition, options.keepalive);
      this.needsCloseRetry = false;
      this.callbacks.onFinalized?.(result);
      if (disposition === "complete") this.setState("ended", "Conversation saved");
      return result;
    } catch (error) {
      this.setState(
        "error",
        `${error?.message ?? "Twin could not save this conversation."} Your completed transcript is still visible; retry saving.`,
      );
      throw error;
    }
  }

  async requestProviderDrain(timeoutMs, quietMs, pollMs) {
    const startedAt = Date.now();
    this.lastProviderActivityAt = Math.max(this.lastProviderActivityAt ?? 0, startedAt);
    if (this.hasUncommittedInput && this.channel?.readyState === "open") {
      try {
        this.pendingCommitEventId = `twin-commit-${crypto.randomUUID()}`;
        this.awaitingCommitAcknowledgement = true;
        this.channel.send(
          JSON.stringify({
            type: "input_audio_buffer.commit",
            event_id: this.pendingCommitEventId,
          }),
        );
      } catch {}
    }
    while (Date.now() - startedAt < timeoutMs) {
      const now = Date.now();
      const lastActivity = Math.max(
        startedAt,
        this.lastProviderActivityAt ?? 0,
        this.lastAudibleAt ?? 0,
      );
      if (
        this.pendingResponses.size === 0 &&
        !this.awaitingCommitAcknowledgement &&
        this.pendingInputTranscriptions.size === 0 &&
        this.outputLevel <= 0.035 &&
        now - lastActivity >= quietMs
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async abandonRecoveredSession(conversationId, voiceSessionId) {
    const response = await fetch(
      `/api/talk/conversations/${encodeURIComponent(conversationId)}/voice-calls/${encodeURIComponent(voiceSessionId)}/abandon`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `voice-abandon-${voiceSessionId}`,
        },
        body: "{}",
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(payload.message ?? "Twin could not close the previous voice connection.");
    return payload;
  }

  async persistClose(items, disposition, keepalive = false) {
    const response = await fetch(
      `/api/talk/conversations/${encodeURIComponent(this.conversationId)}/voice-calls/${encodeURIComponent(this.voiceSessionId)}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `voice-complete-${this.voiceSessionId}`,
        },
        body: JSON.stringify({ items, disposition }),
        keepalive,
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(payload.message ?? "Twin could not close the voice session.");
    return payload;
  }

  async abandon(message, options = {}) {
    if (this.closingPromise) return this.closingPromise;
    this.setState("error", message);
    this.closingPromise = this.closeAndPersist("abandoned", {
      drainMs: 250,
      ...options,
    });
    try {
      const result = await this.closingPromise;
      this.setState("error", message);
      return result;
    } finally {
      this.closingPromise = null;
    }
  }

  async fail(message) {
    if (this.voiceSessionId) {
      try {
        await this.abandon(message);
      } catch {}
      return;
    }
    this.cancelPrepared(message);
  }

  cancelPrepared(message) {
    const pendingMicrophone = this.microphonePromise;
    this.teardown(false);
    pendingMicrophone
      ?.then((stream) => {
        for (const track of stream.getTracks()) track.stop();
      })
      .catch(() => {});
    this.setState("error", message);
  }

  teardown(keepItems = true) {
    globalThis.cancelAnimationFrame?.(this.meterFrame);
    this.meterFrame = null;
    this.channel?.close();
    this.peer?.close();
    for (const track of this.localStream?.getTracks?.() ?? []) track.stop();
    for (const track of this.remoteStream?.getTracks?.() ?? []) track.stop();
    this.inputContext?.close().catch(() => {});
    this.outputContext?.close().catch(() => {});
    this.remoteAudio?.remove();
    this.channel = null;
    this.peer = null;
    this.localStream = null;
    this.remoteStream = null;
    this.remoteAudio = null;
    this.inputContext = null;
    this.outputContext = null;
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.microphonePromise = null;
    this.inputLevel = 0;
    this.outputLevel = 0;
    this.callbacks.onLevels?.({ input: 0, output: 0 });
    this.pendingResponses.clear();
    this.pendingInputTranscriptions.clear();
    this.awaitingCommitAcknowledgement = false;
    this.pendingCommitEventId = null;
    this.hasUncommittedInput = false;
    if (!keepItems) this.items.clear();
  }

  resetForRetry() {
    if (this.closingPromise || this.needsCloseRetry) return;
    this.teardown(false);
    this.voiceSessionId = null;
    if (!this.retainStartIdempotencyKey) this.startIdempotencyKey = null;
    this.setState("idle");
  }
}

globalThis.VoiceTalkController = VoiceTalkController;
globalThis.TwinVoiceAudio = { smoothAudioLevel, rmsAudioLevel };
