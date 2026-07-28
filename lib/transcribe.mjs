// Voice-note transcription for the messaging agent. Claude doesn't take audio
// input, so voice messages are transcribed first via OpenAI Whisper
// (OPENAI_API_KEY env; ~$0.006/min) and the text flows into the normal agent
// pipeline.

const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // Whisper caps uploads at 25MB

export async function transcribeAudio(buffer, filename = "audio.ogg") {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Falta OPENAI_API_KEY (necesaria para transcribir audios)");
  if (buffer.length > MAX_AUDIO_BYTES) throw new Error("El audio es demasiado largo");

  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  form.append("model", "whisper-1"); // language auto-detected (team speaks Spanish and English)

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper ${res.status}: ${await res.text()}`);
  const { text } = await res.json();
  return String(text || "").trim();
}
