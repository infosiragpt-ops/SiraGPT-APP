"""Area "media": audio, video, MIDI, speech and subtitles.

Every test synthesises its own material (a 440 Hz tone, colour clips, a
three-note melody) so the proof needs no fixtures and no network, and reads
the result back with an independent tool (ffprobe, soundfile, mido, ...).
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
import textwrap

import pytest

TONE_HZ = 440.0
RATE = 22050


# --------------------------------------------------------------------------- helpers
def write_tone(path, seconds=1.0, rate=RATE, hz=TONE_HZ):
    """1-s mono 440 Hz sine as a 16-bit WAV, via numpy + soundfile."""
    import numpy as np
    import soundfile as sf
    t = np.arange(int(rate * seconds)) / rate
    samples = (0.5 * np.sin(2 * math.pi * hz * t)).astype("float32")
    sf.write(str(path), samples, rate, subtype="PCM_16")
    return path


def wav_duration(path) -> float:
    import soundfile as sf
    info = sf.info(str(path))
    return info.frames / info.samplerate


def ffprobe_duration(check, path) -> float:
    done = check.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                      "-of", "json", str(path)])
    return float(json.loads(done.stdout)["format"]["duration"])


def write_three_note_midi(path):
    """C4 E4 G4 quarter notes with MIDIUtil (used by several readers)."""
    from midiutil import MIDIFile
    midi = MIDIFile(1)
    midi.addTempo(0, 0, 120)
    for beat, pitch in enumerate((60, 64, 67)):
        midi.addNote(0, 0, pitch, beat, 1, 100)
    with open(path, "wb") as handle:
        midi.writeFile(handle)
    return path


# --------------------------------------------------------------------------- audio
@pytest.mark.covers("soundfile")
def test_soundfile_writes_and_reads_pcm_wav(out, check):
    import numpy as np
    import soundfile as sf
    wav = write_tone(out / "tono.wav")
    check.nonempty(wav, 1000)
    data, rate = sf.read(str(wav), dtype="float32")
    assert rate == RATE
    assert data.shape == (RATE,)
    assert 0.3 < float(np.abs(data).max()) <= 0.51  # amplitude survived the 16-bit round trip
    # Also a FLAC round trip, the lossless format the transcription pipeline uses.
    flac = out / "tono.flac"
    sf.write(str(flac), data, rate)
    back, back_rate = sf.read(str(flac), dtype="float32")
    assert back_rate == rate and len(back) == len(data)
    assert float(np.abs(back - data).max()) < 1e-3


@pytest.mark.covers("pydub", "ffmpeg")
def test_pydub_converts_wav_to_mp3_and_back(out, check):
    from pydub import AudioSegment
    wav = write_tone(out / "tono.wav")
    seg = AudioSegment.from_wav(str(wav))
    assert 950 <= len(seg) <= 1050
    mp3 = out / "tono.mp3"
    seg.export(str(mp3), format="mp3", bitrate="128k")
    check.nonempty(mp3, 4000)
    decoded = AudioSegment.from_file(str(mp3))
    assert 900 <= len(decoded) <= 1200
    # Back to WAV with pydub processing: half the volume (-6 dB) and a fade.
    quieter = (decoded - 6).fade_out(200)
    back = out / "vuelta.wav"
    quieter.export(str(back), format="wav")
    assert 0.9 <= wav_duration(back) <= 1.2
    assert quieter.dBFS < decoded.dBFS - 4


@pytest.mark.covers("ffmpeg")
def test_ffmpeg_python_transcodes_and_cli_filters(out, check):
    import ffmpeg  # ffmpeg-python
    wav = write_tone(out / "tono.wav")
    mp3 = out / "tono.mp3"
    ffmpeg.input(str(wav)).output(str(mp3), acodec="libmp3lame", audio_bitrate="96k").run(
        quiet=True, overwrite_output=True)
    check.nonempty(mp3, 4000)
    probe = ffmpeg.probe(str(mp3))
    assert 0.9 <= float(probe["format"]["duration"]) <= 1.3
    assert probe["streams"][0]["codec_name"] == "mp3"
    # The CLI directly: trim the tone to its first half and resample to 16 kHz mono.
    half = out / "mitad.wav"
    check.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-t", "0.5", "-ar", "16000", "-ac", "1", str(half)])
    import soundfile as sf
    info = sf.info(str(half))
    assert info.samplerate == 16000 and info.channels == 1
    assert 0.45 <= info.frames / info.samplerate <= 0.55


@pytest.mark.covers("ffprobe")
def test_ffprobe_reports_duration_and_stream_as_json(out, check):
    wav = write_tone(out / "tono.wav")
    done = check.run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(wav)])
    info = json.loads(done.stdout)
    assert 0.95 <= float(info["format"]["duration"]) <= 1.05
    stream = info["streams"][0]
    assert stream["codec_type"] == "audio"
    assert int(stream["sample_rate"]) == RATE
    assert int(stream["channels"]) == 1


@pytest.mark.covers("sox")
def test_sox_applies_gain_and_reports_duration(out, check):
    import numpy as np
    import soundfile as sf
    wav = write_tone(out / "tono.wav")
    quieter = out / "menos3db.wav"
    check.run(["sox", str(wav), str(quieter), "gain", "-3"])
    done = check.run(["sox", "--i", "-D", str(quieter)])  # same as soxi -D
    assert 0.95 <= float(done.stdout.strip()) <= 1.05
    before, _ = sf.read(str(wav), dtype="float32")
    after, _ = sf.read(str(quieter), dtype="float32")
    ratio = float(np.sqrt(np.mean(after ** 2)) / np.sqrt(np.mean(before ** 2)))
    assert abs(20 * math.log10(ratio) + 3) < 0.3, f"gain -3 dB came out as {20 * math.log10(ratio):.2f} dB"
    # sox can also synthesise: a 0.5-s 1 kHz tone from nothing.
    synth = out / "synth.wav"
    check.run(["sox", "-n", "-r", "16000", str(synth), "synth", "0.5", "sine", "1000"])
    assert 0.45 <= wav_duration(synth) <= 0.55


@pytest.mark.covers("mediainfo")
def test_mediainfo_describes_audio_as_json(out, check):
    wav = write_tone(out / "tono.wav")
    done = check.run(["mediainfo", "--Output=JSON", str(wav)])
    report = json.loads(done.stdout)
    tracks = report["media"]["track"]
    kinds = {track.get("@type") for track in tracks}
    assert {"General", "Audio"} <= kinds
    audio = next(track for track in tracks if track["@type"] == "Audio")
    assert int(audio["SamplingRate"]) == RATE
    assert int(audio["Channels"]) == 1
    general = next(track for track in tracks if track["@type"] == "General")
    assert 0.9 <= float(general["Duration"]) <= 1.1


@pytest.mark.covers("librosa")
def test_librosa_loads_and_estimates_pitch(out):
    import librosa
    import numpy as np
    wav = write_tone(out / "tono.wav")
    y, sr = librosa.load(str(wav), sr=None, mono=True)
    assert sr == RATE and len(y) == RATE
    spec = librosa.stft(y, n_fft=1024, hop_length=256)
    assert spec.shape[0] == 513
    assert spec.shape[1] == 1 + len(y) // 256
    f0 = librosa.yin(y, fmin=100, fmax=1000, sr=sr)
    median = float(np.median(f0))
    assert abs(median - TONE_HZ) < 5, f"yin estimated {median:.1f} Hz for a {TONE_HZ} Hz tone"
    rms = librosa.feature.rms(y=y)
    assert 0.3 < float(rms.mean()) < 0.4  # 0.5 amplitude sine -> rms ~0.354
    mel = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=32)
    assert mel.shape[0] == 32
    assert librosa.get_duration(y=y, sr=sr) == pytest.approx(1.0, abs=0.01)


# --------------------------------------------------------------------------- speech
@pytest.mark.covers("espeak-ng")
def test_espeak_ng_synthesises_spanish_to_wav(out, check):
    wav = out / "hola.wav"
    check.run(["espeak-ng", "-v", "es", "-w", str(wav), "Hola mundo, esto es una prueba"])
    check.nonempty(wav, 5000)
    assert wav_duration(wav) > 0.3
    # It also answers in text: phonemes for a word.
    done = check.run(["espeak-ng", "-v", "es", "-q", "-x", "hola"])
    assert done.stdout.strip()


PYTTSX3_SCRIPT = textwrap.dedent("""
    import sys
    import pyttsx3
    engine = pyttsx3.init()
    try:
        engine.setProperty("voice", "spanish")
    except Exception:
        pass
    engine.save_to_file("Hola mundo desde SiraGPT", sys.argv[1])
    engine.runAndWait()
    print("pyttsx3-ok")
""")


@pytest.mark.covers("pyttsx3")
def test_pyttsx3_saves_speech_through_espeak(out):
    """pyttsx3 drives libespeak-ng; it hangs easily headless, so run it in a child."""
    script = out / "tts.py"
    script.write_text(PYTTSX3_SCRIPT, encoding="utf-8")
    wav = out / "tts.wav"
    has_espeak = shutil.which("espeak-ng") is not None
    try:
        done = subprocess.run([sys.executable, str(script), str(wav)], capture_output=True, text=True,
                              timeout=30, check=False)
    except subprocess.TimeoutExpired:
        if not has_espeak:
            pytest.skip("pyttsx3 hung and espeak-ng is not installed here")
        raise AssertionError("pyttsx3 hung for 30 s with espeak-ng installed")
    if done.returncode != 0 or not wav.exists():
        detail = (done.stderr or done.stdout).strip()[-600:]
        if not has_espeak:
            pytest.skip(f"pyttsx3 has no speech engine here: {detail}")
        raise AssertionError(
            "pyttsx3 could not synthesise with espeak-ng on PATH (needs libespeak-ng.so.1 and "
            f"espeak-ng-data): {detail}")
    assert "pyttsx3-ok" in done.stdout
    assert os.path.getsize(wav) > 1000
    assert wav_duration(wav) > 0.3


# --------------------------------------------------------------------------- video
@pytest.mark.covers("ffmpeg", "ffprobe")
def test_ffmpeg_builds_video_from_png_frames_and_cuts_it(out, check):
    """A colour-fade MP4 from PNG frames (ffmpeg-python), then a -ss/-t cut and a GIF."""
    import ffmpeg  # ffmpeg-python
    from PIL import Image
    frames = out / "frames"
    frames.mkdir()
    for i in range(12):  # 12 frames at 12 fps = 1 s
        Image.new("RGB", (96, 64), (200 - i * 15, 30, 30 + i * 15)).save(frames / f"f{i:03d}.png")
    mp4 = out / "clip.mp4"
    (ffmpeg.input(str(frames / "f%03d.png"), framerate=12)
     .output(str(mp4), vcodec="libx264", pix_fmt="yuv420p")
     .run(quiet=True, overwrite_output=True))
    check.nonempty(mp4, 1000)
    assert 0.9 <= ffprobe_duration(check, mp4) <= 1.1
    probe = ffmpeg.probe(str(mp4))
    video = next(s for s in probe["streams"] if s["codec_type"] == "video")
    assert video["codec_name"] == "h264"
    assert (int(video["width"]), int(video["height"])) == (96, 64)
    # Cut the second half with -ss/-t.
    half = out / "mitad.mp4"
    ffmpeg.input(str(mp4), ss=0.5).output(str(half), t=0.5, vcodec="libx264", pix_fmt="yuv420p").run(
        quiet=True, overwrite_output=True)
    assert 0.4 <= ffprobe_duration(check, half) <= 0.6
    # A synthetic source (lavfi testsrc) with a tone, through the CLI.
    synth = out / "testsrc.mp4"
    check.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=128x72:rate=10:duration=1",
               "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest",
               "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(synth)])
    kinds = {s["codec_type"] for s in ffmpeg.probe(str(synth))["streams"]}
    assert kinds == {"video", "audio"}
    assert 0.9 <= ffprobe_duration(check, synth) <= 1.2
    # And a GIF from the clip, read back with Pillow.
    gif = out / "clip.gif"
    ffmpeg.input(str(mp4)).output(str(gif), r=6).run(quiet=True, overwrite_output=True)
    with Image.open(gif) as img:
        assert img.format == "GIF" and getattr(img, "n_frames", 1) >= 4 and img.size == (96, 64)


@pytest.mark.covers("imageio_ffmpeg")
def test_imageio_ffmpeg_exposes_binary_and_reads_frames(out, check):
    import imageio_ffmpeg
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    assert exe and os.path.exists(exe), exe
    assert imageio_ffmpeg.get_ffmpeg_version()[0].isdigit()
    # Make a short video with its writer, then read the frames back.
    import numpy as np
    mp4 = out / "ruido.mp4"
    writer = imageio_ffmpeg.write_frames(str(mp4), (64, 48), fps=10, codec="libx264", pix_fmt_in="rgb24",
                                        macro_block_size=1)
    writer.send(None)
    for i in range(10):
        writer.send(np.full((48, 64, 3), i * 20, dtype=np.uint8).tobytes())
    writer.close()
    check.nonempty(mp4, 500)
    reader = imageio_ffmpeg.read_frames(str(mp4))
    meta = next(reader)
    assert tuple(meta["size"]) == (64, 48)
    frames = list(reader)
    assert 8 <= len(frames) <= 12
    assert len(frames[0]) == 64 * 48 * 3
    assert 0.8 <= ffprobe_duration(check, mp4) <= 1.2


# --------------------------------------------------------------------------- MIDI
@pytest.mark.covers("mido")
def test_mido_writes_and_reads_midi_messages(out, check):
    import mido
    mid = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120)))
    for pitch in (60, 64, 67):
        track.append(mido.Message("note_on", note=pitch, velocity=90, time=0))
        track.append(mido.Message("note_off", note=pitch, velocity=0, time=480))
    path = out / "acorde.mid"
    mid.save(str(path))
    check.nonempty(path, 40)
    back = mido.MidiFile(str(path))
    assert back.ticks_per_beat == 480
    notes = [m.note for m in back.tracks[0] if m.type == "note_on"]
    assert notes == [60, 64, 67]
    assert back.length == pytest.approx(1.5, abs=0.01)  # three quarter notes at 120 bpm


@pytest.mark.covers("midiutil")
def test_midiutil_melody_is_read_by_mido(out, check):
    import mido
    path = write_three_note_midi(out / "melodia.mid")
    check.nonempty(path, 40)
    back = mido.MidiFile(str(path))
    note_ons = [m for track in back.tracks for m in track if m.type == "note_on" and m.velocity > 0]
    assert [m.note for m in note_ons] == [60, 64, 67]
    assert any(m.type == "set_tempo" and round(mido.tempo2bpm(m.tempo)) == 120
               for track in back.tracks for m in track)


@pytest.mark.covers("pretty_midi")
def test_pretty_midi_analyses_notes_and_timing(out):
    import pretty_midi
    path = write_three_note_midi(out / "melodia.mid")
    pm = pretty_midi.PrettyMIDI(str(path))
    assert pm.get_end_time() == pytest.approx(1.5, abs=0.02)
    notes = sorted(pm.instruments[0].notes, key=lambda n: n.start)
    assert [n.pitch for n in notes] == [60, 64, 67]
    assert [pretty_midi.note_number_to_name(n.pitch) for n in notes] == ["C4", "E4", "G4"]
    assert notes[1].start == pytest.approx(0.5, abs=0.02)
    roll = pm.get_piano_roll(fs=10)
    assert roll.shape[0] == 128 and roll.shape[1] >= 14
    assert pm.estimate_tempo() > 0


@pytest.mark.covers("music21")
def test_music21_writes_musicxml_and_midi_and_reparses(out, monkeypatch):
    monkeypatch.setenv("HOME", str(out))  # music21 keeps its settings file under ~
    from music21 import converter, note, stream
    part = stream.Part()
    for name in ("C4", "E4", "G4"):
        part.append(note.Note(name, quarterLength=1))
    score = stream.Score([part])
    xml = out / "melodia.musicxml"
    score.write("musicxml", fp=str(xml))
    assert xml.stat().st_size > 500
    assert b"<score-partwise" in xml.read_bytes()
    parsed = converter.parse(str(xml))
    pitches = [p.nameWithOctave for p in parsed.flatten().pitches]
    assert pitches == ["C4", "E4", "G4"]
    midi = out / "melodia.mid"
    score.write("midi", fp=str(midi))
    import mido
    note_ons = [m for track in mido.MidiFile(str(midi)).tracks for m in track
                if m.type == "note_on" and m.velocity > 0]
    assert [m.note for m in note_ons] == [60, 64, 67]
    assert converter.parse(str(midi)).flatten().notes.__len__() == 3


# --------------------------------------------------------------------------- subtitles
@pytest.mark.covers("pysubs2")
def test_pysubs2_saves_srt_and_ass_and_loads_back(out, check):
    import pysubs2
    subs = pysubs2.SSAFile()
    subs.append(pysubs2.SSAEvent(start=pysubs2.make_time(s=0.5), end=pysubs2.make_time(s=2), text="Hola mundo"))
    subs.append(pysubs2.SSAEvent(start=pysubs2.make_time(s=2.5), end=pysubs2.make_time(s=4), text="Segunda línea"))
    srt_path = out / "subs.srt"
    ass_path = out / "subs.ass"
    subs.save(str(srt_path))
    subs.save(str(ass_path))
    check.nonempty(srt_path, 40)
    check.nonempty(ass_path, 200)
    text = srt_path.read_text(encoding="utf-8")
    assert "00:00:00,500 --> 00:00:02,000" in text and "Segunda línea" in text
    back = pysubs2.load(str(srt_path))
    assert len(back) == 2 and back[1].text == "Segunda línea" and back[1].start == 2500
    ass = pysubs2.load(str(ass_path))
    assert ass.format == "ass" and [e.text for e in ass] == ["Hola mundo", "Segunda línea"]
    shifted = pysubs2.load(str(srt_path))
    shifted.shift(s=1)
    assert shifted[0].start == 1500


@pytest.mark.covers("srt")
def test_srt_composes_and_parses(out, check):
    from datetime import timedelta
    import srt
    subs = [
        srt.Subtitle(index=1, start=timedelta(seconds=0.5), end=timedelta(seconds=2), content="Hola mundo"),
        srt.Subtitle(index=2, start=timedelta(seconds=2.5), end=timedelta(seconds=4), content="Adiós"),
    ]
    text = srt.compose(subs)
    path = out / "subs.srt"
    path.write_text(text, encoding="utf-8")
    check.nonempty(path, 40)
    assert "00:00:02,500 --> 00:00:04,000" in text
    parsed = list(srt.parse(path.read_text(encoding="utf-8")))
    assert [s.content for s in parsed] == ["Hola mundo", "Adiós"]
    assert parsed[1].start == timedelta(seconds=2.5)
    assert srt.timedelta_to_srt_timestamp(timedelta(seconds=61.25)) == "00:01:01,250"


@pytest.mark.covers("webvtt")
def test_webvtt_builds_saves_and_reads(out, check):
    import webvtt
    vtt = webvtt.WebVTT()
    vtt.captions.append(webvtt.Caption("00:00:00.500", "00:00:02.000", "Hola mundo"))
    vtt.captions.append(webvtt.Caption("00:00:02.500", "00:00:04.000", ["Segunda", "línea"]))
    path = out / "subs.vtt"
    vtt.save(str(path))
    check.nonempty(path, 40)
    text = path.read_text(encoding="utf-8")
    assert text.startswith("WEBVTT")
    assert "00:00:02.500 --> 00:00:04.000" in text
    back = webvtt.read(str(path))
    assert len(back.captions) == 2
    assert back.captions[0].text == "Hola mundo"
    assert back.captions[1].lines == ["Segunda", "línea"]
    assert back.captions[1].start == "00:00:02.500" and back.captions[1].end == "00:00:04.000"
    # SRT -> VTT conversion, the usual chore for web players.
    srt_path = out / "subs.srt"
    srt_path.write_text("1\n00:00:00,500 --> 00:00:02,000\nHola\n\n", encoding="utf-8")
    converted = webvtt.from_srt(str(srt_path))
    assert converted.captions[0].text == "Hola"
