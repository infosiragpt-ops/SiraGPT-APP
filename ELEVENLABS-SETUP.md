# ElevenLabs Integration Setup Guide

This guide will help you set up ElevenLabs text-to-speech and speech-to-text functionality in your OpenWebUI platform.

## 🚀 Features Added

### Text-to-Speech (TTS)
- Convert any text to natural-sounding speech
- Multiple AI voices to choose from
- Customizable voice settings (stability, similarity, style)
- High-quality audio generation
- Download generated audio files

### Speech-to-Text (STT)
- Record audio directly in the browser
- Upload audio files for transcription
- Accurate speech recognition
- Support for multiple audio formats

### Chat Integration
- Voice controls in chat interface
- Read AI responses aloud with ElevenLabs voices
- Voice input for messages
- Fallback to browser TTS/STT if ElevenLabs fails

## 📋 Prerequisites

1. **ElevenLabs Account**: Sign up at [elevenlabs.io](https://elevenlabs.io)
2. **API Key**: Get your API key from the ElevenLabs dashboard
3. **Node.js Dependencies**: Install required packages

## 🛠️ Installation Steps

### 1. Install Backend Dependencies

```bash
cd backend
npm install elevenlabs form-data
```

### 2. Environment Configuration

Add your ElevenLabs API key to your backend `.env` file:

```env
# ElevenLabs API Key for Text-to-Speech and Speech-to-Text
ELEVENLABS_API_KEY="your-elevenlabs-api-key-here"
```

### 3. Create Upload Directory

Ensure the audio upload directory exists:

```bash
mkdir -p backend/uploads/audio
```

### 4. Start the Services

```bash
# Start backend
cd backend
npm run dev

# Start frontend (in another terminal)
cd ..
npm run dev
```

## 🎯 Usage

### Standalone Voice Studio

1. Navigate to `/voice` in your application
2. Use the **Text to Speech** tab to:
   - Select a voice from the dropdown
   - Enter text to convert
   - Adjust voice settings (stability, similarity)
   - Generate and play audio
   - Download audio files

3. Use the **Speech to Text** tab to:
   - Record audio using your microphone
   - Upload audio files
   - Get accurate transcriptions
   - Copy transcribed text

### Chat Integration

1. In any chat interface, you'll see new voice controls:
   - **Microphone button**: Record voice input
   - **Settings button**: Configure voice preferences
   - **Play button**: Listen to AI responses

2. Voice features in messages:
   - Click the speaker icon on any AI message to hear it read aloud
   - Uses ElevenLabs voices for high-quality speech
   - Falls back to browser TTS if ElevenLabs is unavailable

## 🔧 Configuration Options

### Voice Settings

- **Stability** (0.0 - 1.0): Controls voice consistency
- **Similarity Boost** (0.0 - 1.0): Enhances voice similarity to original
- **Style** (0.0 - 1.0): Adds expressiveness to the voice
- **Speaker Boost**: Improves audio quality

### Voice Director (`POST /api/ai/generate-speech`)

The chat composer's Voice mode resolves every request through a central
director (`backend/src/services/ai/voice-director.js`), so language, accent,
stability and effect behave identically on any speech model:

- **Model catalog (9)**: Eleven V3 (70+ languages, native audio tags) ·
  Multilingual V2 (29 languages, most natural) · Flash V2.5 (32 languages,
  ~75 ms, 40k chars) · Gemini Flash/Pro TTS (100+ languages) ·
  OpenAI TTS / TTS HD / GPT-4o mini TTS (multilingüe; mini acepta
  instrucciones de estilo) · Turbo V2.5 (legacy). Old labels (`ElevenLabs`,
  `eleven-turbo-v2`, …) keep resolving via aliases.
- **Works with ANY configured voice provider**: the route chains planned
  provider first, then every remaining CONFIGURED provider (ElevenLabs →
  Gemini → OpenAI). Any single key gives voice; with zero keys the API
  answers 503 with `{ fallback: "browser-tts", languageBcp47, rate }` and the
  composer speaks locally via the Web Speech API. Voice never depends on the
  chat LLM.
- **PROD POLICY (siragpt.com)**: `OPENAI_TTS_API_BASE` MUST stay at the
  default direct OpenAI endpoint. Do NOT point it at OpenRouter or any other
  model gateway — prohibited in production. Env (names only, values live in
  the prod .env on the Lenovo, never in chat): `OPENAI_TTS_MODEL` (default
  `tts-1`), `OPENAI_TTS_VOICE` (default `alloy`), `OPENAI_TTS_TIMEOUT_MS`.
- **Stability slider (0-100)** shapes the full ElevenLabs curve (stability +
  similarity boost + style), not just the stability knob. Low = expressive,
  high = consistent. On OpenAI it maps to `speed` (effect sets the base pace,
  stability tilts ±0.05); on `gpt-4o-mini-tts` it also builds `instructions`
  with language + accent + effect.
- **Auto-routing with warnings**: impossible combinations are upgraded, never
  silently ignored — e.g. Turbo V2 + Spanish → Flash V2.5, or a v3-only
  language (Bengalí, hebreo, …) → Eleven V3 / Gemini. The response carries a
  `warnings[]` array and the applied `voice` config, surfaced as toasts.
- **Accents are per-language** (Spanish → Latino/Mexican/Spain/Argentino/
  Colombiano/…, English → US/British/Australian/…) with per-language
  defaults; unknown accents fall back with a warning.

### Supported Audio Formats

- **Input**: MP3, WAV, M4A, WebM
- **Output**: MP3 (high quality)
- **Max File Size**: 25MB

## 🎨 UI Components

### ElevenLabsInterface
- Full-featured voice studio interface
- Tabbed layout for TTS and STT
- Voice selection and settings
- Audio playback controls

### VoiceControls
- Compact voice controls for chat integration
- Recording functionality
- Voice settings popover
- Transcription callback support

## 📡 API Endpoints

### Backend Routes (`/api/elevenlabs/`)

- `GET /voices` - Get available voices
- `POST /text-to-speech` - Convert text to speech
- `POST /speech-to-text` - Convert speech to text
- `GET /audio/:filename` - Serve audio files
- `GET /voices/:id/settings` - Get voice settings
- `GET /user/subscription` - Get subscription info

### Frontend API Methods

```typescript
// Get available voices
const voices = await apiClient.getVoices()

// Text to speech
const audio = await apiClient.textToSpeech({
  text: "Hello world",
  voice_id: "voice-id",
  voice_settings: { stability: 0.5 }
})

// Speech to text
const result = await apiClient.speechToText(audioFile)
```

## 🔒 Security Features

- JWT authentication required for all endpoints
- File type validation for uploads
- File size limits
- Automatic cleanup of temporary files
- API usage tracking

## 🚨 Error Handling

- Graceful fallback to browser TTS/STT
- User-friendly error messages
- Automatic retry mechanisms
- File cleanup on errors

## 📊 Usage Tracking

All ElevenLabs API usage is tracked in the database:
- Token/character count
- Cost calculation
- User attribution
- Model identification

## 🎵 Future Enhancements

The current implementation focuses on TTS and STT. Future updates will include:

- **Music Generation**: AI-powered music creation
- **Voice Cloning**: Custom voice training
- **Real-time Streaming**: Live audio processing
- ~~**Multi-language Support**~~: ✅ shipped — 44 languages via the Voice Director
- ~~**Advanced Audio Effects**~~: ✅ shipped — Studio Clean / Warm / Cinematic / Narration / Podcast per-model effects

## 🐛 Troubleshooting

### Common Issues

1. **API Key Not Working**
   - Verify your ElevenLabs API key is correct
   - Check if you have sufficient credits
   - Ensure the key has proper permissions

2. **Microphone Not Working**
   - Check browser permissions for microphone access
   - Ensure you're using HTTPS (required for microphone)
   - Try refreshing the page

3. **Audio Not Playing**
   - Check browser audio permissions
   - Verify audio file was generated successfully
   - Try downloading and playing the file directly

4. **Upload Failures**
   - Check file size (max 25MB)
   - Verify file format is supported
   - Ensure backend upload directory exists

### Debug Mode

Enable debug logging by setting:
```env
NODE_ENV=development
```

## 📞 Support

For issues related to:
- **ElevenLabs API**: Contact ElevenLabs support
- **Integration Issues**: Check the console for error messages
- **Feature Requests**: Submit via GitHub issues

## 🔗 Useful Links

- [ElevenLabs Documentation](https://docs.elevenlabs.io/)
- [ElevenLabs Dashboard](https://elevenlabs.io/app)
- [Voice Library](https://elevenlabs.io/voice-library)
- [Pricing Plans](https://elevenlabs.io/pricing)

---

**Note**: This integration requires an active ElevenLabs subscription for production use. The free tier has limited usage quotas.