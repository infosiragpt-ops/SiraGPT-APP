// "use client"

// import React, { useState, useRef, useEffect } from 'react'
// import { Button } from '@/components/ui/button'
// import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
// import { Textarea } from '@/components/ui/textarea'

// import { Slider } from '@/components/ui/slider'
// import { Label } from '@/components/ui/label'
// import { Badge } from '@/components/ui/badge'
// import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
// import { Progress } from '@/components/ui/progress'
// import { useToast } from '@/hooks/use-toast'
// import apiClient from '@/lib/api'
// import VoiceSelector from './voice-selector'
// import {
//     Mic,
//     Play,
//     Pause,
//     Square,
//     Download,
//     Upload,
//     Volume2,
//     Settings,
//     //     FileAudio,
//     MessageSquare
// } from 'lucide-react'

// interface Voice {
//     voiceId: string
//     name: string
//     category: string
//     description?: string
//     previewUrl?: string
//     labels?: { [key: string]: string }
// }

// interface VoiceSettings {
//     stability: number
//     similarity_boost: number
//     style: number
//     use_speaker_boost: boolean
// }

// export default function TextToSpeechComponent() {
//     const { toast } = useToast()

//     // State management
//     const [voices, setVoices] = useState<Voice[]>([])
//     const [selectedVoice, setSelectedVoice] = useState<string>('')
//     const [text, setText] = useState('')
//     const [isLoading, setIsLoading] = useState(false)
//     const [isRecording, setIsRecording] = useState(false)
//     const [isPlaying, setIsPlaying] = useState(false)
//     const [audioUrl, setAudioUrl] = useState<string | null>(null)


//     const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
//         stability: 0.5,
//         similarity_boost: 0.5,
//         style: 0.0,
//         use_speaker_boost: true
//     })

//     // Refs
//     const mediaRecorderRef = useRef<MediaRecorder | null>(null)
//     const audioChunksRef = useRef<Blob[]>([])
//     const audioRef = useRef<HTMLAudioElement | null>(null)
//     const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null)
//     const fileInputRef = useRef<HTMLInputElement | null>(null)

//     // YEH सुनिश्चित करने के लिए REF hai कि VOICES सिर्फ एक बार लोड हों
//     const voicesLoaded = useRef(false);


//     // Load voices on component mount
//     useEffect(() => {

//         if (!voicesLoaded.current) {
//             loadVoices()

//             voicesLoaded.current = true;
//         }
//     }, [])


//     // Sync audio element when audioUrl changes
//     useEffect(() => {
//         if (audioUrl && audioRef.current) {
//             // Ensure the audio element has the correct src
//             const expectedSrc = `${apiClient.apiBaseURL}${audioUrl}`
//             if (audioRef.current.src !== expectedSrc) {
//                 audioRef.current.src = expectedSrc
//             }

//             // Set up event listeners for synchronization
//             const audio = audioRef.current

//             const handleEnded = () => setIsPlaying(false)
//             const handlePause = () => setIsPlaying(false)
//             const handlePlay = () => setIsPlaying(true)
//             const handleLoadStart = () => setIsPlaying(false)

//             audio.addEventListener('ended', handleEnded)
//             audio.addEventListener('pause', handlePause)
//             audio.addEventListener('play', handlePlay)
//             audio.addEventListener('loadstart', handleLoadStart)

//             return () => {
//                 audio.removeEventListener('ended', handleEnded)
//                 audio.removeEventListener('pause', handlePause)
//                 audio.removeEventListener('play', handlePlay)
//                 audio.removeEventListener('loadstart', handleLoadStart)
//             }
//         }
//     }, [audioUrl])

//     // Cleanup on component unmount
//     useEffect(() => {
//         return () => {
//             if (audioRef.current) {
//                 audioRef.current.pause()
//                 setIsPlaying(false)
//             }
//         }
//     }, [])

//     const loadVoices = async () => {
//         try {
//             console.log('Loading voices...')
//             const response = await apiClient.getVoices()
//             console.log('Voices response:', response)
//             setVoices(response.voices || [])
//             if (response.voices && response.voices.length > 0) {
//                 setSelectedVoice(response.voices[0].voiceId)
//                 console.log('Selected voice:', response.voices[0].voiceId)
//             }
//         } catch (error) {
//             console.error('Error loading voices:', error)
//             toast({
//                 title: "Error",
//                 description: "Failed to load voices. Please check your ElevenLabs API key.",
//                 variant: "destructive"
//             })
//         }
//     }

//     const handleTextToSpeech = async () => {
//         console.log("Starting TTS with:", { text, selectedVoice, voiceSettings })
//         if (!text.trim()) {
//             toast({
//                 title: "Error",
//                 description: "Please enter some text to convert to speech.",
//                 variant: "destructive"
//             })
//             return
//         }

//         if (!selectedVoice) {
//             toast({
//                 title: "Error",
//                 description: "Please select a voice first.",
//                 variant: "destructive"
//             })
//             return
//         }

//         console.log("Selected voice ID:", selectedVoice)
//         console.log("Available voices:", voices.length)
//         setIsLoading(true)
//         try {
//             console.log('Making TTS request with:', {
//                 text,
//                 voice_id: selectedVoice,
//                 voice_settings: voiceSettings
//             })

//             const response = await apiClient.textToSpeech({
//                 text,
//                 voice_id: selectedVoice,
//                 voice_settings: voiceSettings
//             })

//             console.log('TTS response:', response)

//             if (response.audio_url) {
//                 setAudioUrl(response.audio_url)

//                 // Wait a bit for the audio element to be ready, then auto-play
//                 setTimeout(() => {
//                     if (audioRef.current) {
//                         // Set up event listeners for the existing audio element
//                         audioRef.current.onended = () => setIsPlaying(false)
//                         audioRef.current.onpause = () => setIsPlaying(false)
//                         audioRef.current.onplay = () => setIsPlaying(true)
//                         audioRef.current.onloadstart = () => setIsPlaying(false)

//                         // Auto-play the generated audio
//                         audioRef.current.play()
//                         setIsPlaying(true)
//                     }
//                 }, 100)

//                 toast({
//                     title: "Success",
//                     description: "Audio generated and playing!",
//                 })
//             }
//         } catch (error: any) {
//             toast({
//                 title: "Error",
//                 description: error.message || "Failed to generate audio",
//                 variant: "destructive"
//             })
//         } finally {
//             setIsLoading(false)
//         }
//     }



//     const playAudio = () => {
//         if (audioUrl && audioRef.current) {
//             if (isPlaying) {
//                 audioRef.current.pause()
//                 setIsPlaying(false)
//             } else {
//                 // Set up event listeners if not already set
//                 if (!audioRef.current.onended) {
//                     audioRef.current.onended = () => setIsPlaying(false)
//                     audioRef.current.onpause = () => setIsPlaying(false)
//                     audioRef.current.onplay = () => setIsPlaying(true)
//                 }

//                 audioRef.current.play()
//                 setIsPlaying(true)
//             }
//         }
//     }

//     const downloadAudio = async () => {
//         if (audioUrl) {
//             try {
//                 const filename = audioUrl.split('/').pop() || 'audio.mp3'
//                 const blob = await apiClient.getAudioFile(filename)
//                 const url = URL.createObjectURL(blob)
//                 const a = document.createElement('a')
//                 a.href = url
//                 a.download = filename
//                 document.body.appendChild(a)
//                 a.click()
//                 document.body.removeChild(a)
//                 URL.revokeObjectURL(url)
//             } catch (error) {
//                 toast({
//                     title: "Error",
//                     description: "Failed to download audio",
//                     variant: "destructive"
//                 })
//             }
//         }
//     }



//     return (
//         <div className="max-w-4xl mx-auto p-6 space-y-6">
//             <div className="text-center space-y-2">
//                 <h1 className="text-3xl font-bold bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">
//                     ElevenLabs Voice Studio
//                 </h1>
//                 <p className="text-muted-foreground">
//                     Convert text to speech and speech to text with AI-powered voices
//                 </p>
//             </div>

//             <Tabs defaultValue="tts" className="w-full">
//                 {/* <TabsList className="grid w-full grid-cols-1">
//                     <TabsTrigger value="tts" className="flex items-center gap-2">
//                         <Volume2 className="w-4 h-4" />
//                         Text to Speech
//                     </TabsTrigger>

//                 </TabsList> */}

//                 <TabsContent value="tts" className="space-y-6">
//                     <Card>
//                         <CardHeader>
//                             <CardTitle className="flex items-center gap-1">
//                                 <MessageSquare className="w-5 h-5" />
//                                 Text to Speech
//                             </CardTitle>
//                             <CardDescription>
//                                 Enter text and convert it to natural-sounding speech
//                             </CardDescription>
//                         </CardHeader>
//                         <CardContent className="space-y-4">
//                             <VoiceSelector
//                                 selectedVoice={selectedVoice}
//                                 onVoiceChange={(value) => {
//                                     console.log("ElevenLabs interface - Voice selected:", value)
//                                     setSelectedVoice(value)
//                                 }}
//                                 label="Select Voice"
//                             />

//                             <div className="space-y-2">
//                                 <Label htmlFor="text-input">Text to Convert</Label>
//                                 <Textarea
//                                     id="text-input"
//                                     placeholder="Enter the text you want to convert to speech..."
//                                     value={text}
//                                     onChange={(e) => setText(e.target.value)}
//                                     rows={4}
//                                     className="resize-none"
//                                 />
//                                 <div className="text-sm text-muted-foreground">
//                                     {text.length} characters
//                                 </div>
//                             </div>

//                             <Card className="p-4">
//                                 <div className="flex items-center gap-2 mb-3">
//                                     <Settings className="w-4 h-4" />
//                                     <Label>Voice Settings</Label>
//                                 </div>
//                                 <div className="grid grid-cols-2 gap-4">
//                                     <div className="space-y-2">
//                                         <Label>Stability: {voiceSettings.stability}</Label>
//                                         <Slider
//                                             value={[voiceSettings.stability]}
//                                             onValueChange={([value]) =>
//                                                 setVoiceSettings(prev => ({ ...prev, stability: value }))
//                                             }
//                                             max={1}
//                                             min={0}
//                                             step={0.1}
//                                         />
//                                     </div>
//                                     <div className="space-y-2">
//                                         <Label>Similarity: {voiceSettings.similarity_boost}</Label>
//                                         <Slider
//                                             value={[voiceSettings.similarity_boost]}
//                                             onValueChange={([value]) =>
//                                                 setVoiceSettings(prev => ({ ...prev, similarity_boost: value }))
//                                             }
//                                             max={1}
//                                             min={0}
//                                             step={0.1}
//                                         />
//                                     </div>
//                                 </div>
//                             </Card>

//                             <Button
//                                 onClick={handleTextToSpeech}
//                                 disabled={isLoading || !text.trim()}
//                                 className="w-full"
//                             >
//                                 {isLoading ? (
//                                     <>
//                                         <ThinkingIndicator size="sm" className="mr-2" />
//                                         Generating Audio...
//                                     </>
//                                 ) : (
//                                     <>
//                                         <Volume2 className="w-4 h-4 mr-2" />
//                                         Generate Speech
//                                     </>
//                                 )}
//                             </Button>

//                             {isLoading && (
//                                 <div className="text-center text-sm text-muted-foreground">
//                                     <div className="flex items-center justify-center gap-2">
//                                         <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></div>
//                                         <div className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
//                                         <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
//                                     </div>
//                                     <p className="mt-1">Creating your audio with ElevenLabs...</p>
//                                 </div>
//                             )}

//                             {audioUrl && (
//                                 <Card className="p-4 bg-gradient-to-r from-green-50 to-blue-50 dark:from-green-950/20 dark:to-blue-950/20 border-green-200 dark:border-green-800">
//                                     <div className="flex items-center justify-between">
//                                         <div className="flex items-center gap-2">
//                                             <FileAudio className="w-5 h-5 text-green-600" />
//                                             <span className="font-medium text-green-800 dark:text-green-200">Generated Audio</span>
//                                             {isPlaying && (
//                                                 <div className="flex items-center gap-1 text-green-600">
//                                                     <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
//                                                     <span className="text-xs">Playing</span>
//                                                 </div>
//                                             )}
//                                         </div>
//                                         <div className="flex gap-2">
//                                             <Button
//                                                 variant="outline"
//                                                 size="sm"
//                                                 onClick={playAudio}
//                                                 className={`${isPlaying ? 'bg-green-100 border-green-300 text-green-700' : ''}`}
//                                             >
//                                                 {isPlaying ? (
//                                                     <Pause className="w-4 h-4" />
//                                                 ) : (
//                                                     <Play className="w-4 h-4" />
//                                                 )}
//                                             </Button>
//                                             <Button variant="outline" size="sm" onClick={downloadAudio}>
//                                                 <Download className="w-4 h-4" />
//                                             </Button>
//                                         </div>
//                                     </div>
//                                     <audio
//                                         ref={audioRef}
//                                         src={`${apiClient.apiBaseURL}${audioUrl}`}
//                                         className="w-full mt-2"
//                                         controls
//                                         preload="auto"
//                                     />
//                                     <div className="mt-2 text-xs text-muted-foreground">
//                                         Click the play button above or use the audio controls below - both are synchronized!
//                                     </div>
//                                 </Card>
//                             )}
//                         </CardContent>
//                     </Card>
//                 </TabsContent>


//             </Tabs>
//         </div>
//     )
// } 
"use client"

import React, { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { useToast } from '@/hooks/use-toast'
import apiClient from '@/lib/api'
import VoiceSelector from './voice-selector' // Assume this component is working
import {
    Play,
    Pause,
    Download,
    Settings,
    MessageSquare,
    Share2,
    Rewind,
    FastForward,
    Copy,
    Volume2
} from 'lucide-react'
import { useVoices } from '@/hooks/use-voices'



import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
// Interfaces
interface Voice {
    voiceId: string
    name: string
    category: string
}
interface Model {
    modelId: string
    name: string
}
interface VoiceSettings {
    stability: number
    similarity_boost: number
    style: number
    use_speaker_boost: boolean
}

export default function TextToSpeechComponent() {
    const { toast } = useToast()
// In the component, replace the voices loading logic:
const { voices, loading: voicesLoading } = useVoices()
    // State management
    const [models, setModels] = useState<Model[]>([])
    const [selectedVoice, setSelectedVoice] = useState<string>('')
    const [selectedModel, setSelectedModel] = useState<string>('eleven_multilingual_v2')
    const [text, setText] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [isPlaying, setIsPlaying] = useState(false)
    const [audioUrl, setAudioUrl] = useState<string | null>(null)

    // Player State
    const [duration, setDuration] = useState(0)
    const [currentTime, setCurrentTime] = useState(0)
    const [progress, setProgress] = useState(0)

    const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
        stability: 0.75,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true
    })

    // Refs
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const dataLoaded = useRef({ voices: false, models: false });

    // Load voices and models only once on component mount
    useEffect(() => {
        if (!dataLoaded.current.voices) {
            dataLoaded.current.voices = true;
        }
        if (!dataLoaded.current.models) {
            loadModels()
            dataLoaded.current.models = true;
        }
    }, [])

    // Effect to handle audio player time updates
    useEffect(() => {
        const audio = audioRef.current
        if (audio) {
            const handleTimeUpdate = () => {
                if (!isNaN(audio.duration)) {
                    setCurrentTime(audio.currentTime)
                    setProgress((audio.currentTime / audio.duration) * 100)
                }
            }
            const handleLoadedMetadata = () => setDuration(audio.duration)
            const handleEnded = () => setIsPlaying(false)

            audio.addEventListener('timeupdate', handleTimeUpdate)
            audio.addEventListener('loadedmetadata', handleLoadedMetadata)
            audio.addEventListener('ended', handleEnded)

            return () => {
                audio.removeEventListener('timeupdate', handleTimeUpdate)
                audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
                audio.removeEventListener('ended', handleEnded)
            }
        }
    }, [audioUrl])


    const loadModels = async () => {
        try {
            const response = await apiClient.getModels();
            const availableModels: Model[] = response.models || [];

            setModels(availableModels);
            if (availableModels.length > 0) {
                // Parameter 'm' ko type 'Model' de di gayi hai
                const defaultModel = availableModels.find((m: Model) => m.modelId === 'eleven_multilingual_v2') || availableModels[0];
                console.log(defaultModel)
                setSelectedModel(defaultModel.modelId);
            }
        } catch (error) {
            console.error('Error loading models:', error)
            toast({ title: "Error", description: "Failed to load models.", variant: "destructive" })
        }
    }

    const handleTextToSpeech = async () => {
        if (!text.trim() || !selectedVoice || !selectedModel) {
            toast({ title: "Error", description: "Please enter text, select a voice, and a model.", variant: "destructive" })
            return
        }

        setIsLoading(true)
        try {
            const response = await apiClient.textToSpeech({
                text,
                voice_id: selectedVoice,
                model_id: selectedModel,
                voice_settings: voiceSettings,
            })

            if (response.audio_url) {
                setAudioUrl(response.audio_url)
                setTimeout(() => {
                    audioRef.current?.play()
                    setIsPlaying(true)
                }, 100)
            }
        } catch (error: any) {
            toast({ title: "Error", description: error.message || "Failed to generate audio", variant: "destructive" })
        } finally {
            setIsLoading(false)
        }
    }

    const playAudio = () => {
        if (audioRef.current) {
            if (isPlaying) {
                audioRef.current.pause()
            } else {
                audioRef.current.play()
            }
            setIsPlaying(!isPlaying)
        }
    }

    const handleSeek = (value: number[]) => {
        if (audioRef.current && isFinite(duration)) {
            const newTime = (value[0] / 100) * duration
            audioRef.current.currentTime = newTime
            setCurrentTime(newTime)
        }
    }

    const handleRewind = (seconds: number) => {
        if (audioRef.current) {
            audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - seconds);
        }
    }

const downloadAudio = async () => {
  if (!audioUrl) {
    toast({ title: "Error", description: "No audio file to download.", variant: "destructive" });
    return;
  }

  try {
    const filename = audioUrl.split('/').pop();
    if (!filename) throw new Error("Invalid audio URL");

    toast({ title: "Downloading...", description: "Your audio is being prepared for download." });

    // 🔹 Fetch the real audio file as blob
    const res = await fetch(`${apiClient.apiBaseURL}${audioUrl}`, {
      credentials: 'include', // only if needed
    });
    if (!res.ok) throw new Error("Failed to fetch audio file");
    const blob = await res.blob();

    // 🔹 Create a temp download link
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    // cleanup
    URL.revokeObjectURL(url);
    document.body.removeChild(a);

    toast({ title: "Success", description: "Your audio download has started." });

  } catch (error) {
    console.error("Download error:", error);
    toast({ title: "Download Failed", description: "Could not download the audio file.", variant: "destructive" });
  }
};


    const handleShare = async () => {
        if (!audioUrl) return;
        const fullUrl = `${window.location.origin}${audioUrl}`; // Assuming relative URL
        try {
            if (navigator.share) {
                await navigator.share({
                    title: 'Generated Audio',
                    text: 'Listen to this audio I generated!',
                    url: fullUrl,
                });
            } else {
                await navigator.clipboard.writeText(fullUrl);
                toast({ title: "Copied!", description: "Audio URL copied to clipboard." });
            }
        } catch (error) {
            console.error('Error sharing:', error)
            toast({ title: "Error", description: "Could not share or copy the URL.", variant: "destructive" });
        }
    }

    const formatTime = (seconds: number) => {
        if (isNaN(seconds) || seconds === Infinity) {
            return '0:00';
        }
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    };
    return (
        <div className="max-w-7xl mx-auto p-6 space-y-6 relative pb-32">
            <div className="flex justify-between items-center">
                <h1 className="text-2xl font-semibold">Text to Speech</h1>

            </div>

            <div className="flex flex-col md:flex-row gap-8">
                {/* Main Content */}
                <div className="flex-grow space-y-4">
                    <Textarea
                        id="text-input"
                        placeholder="Escribe el texto que quieres convertir a voz…"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        rows={12}
                        className="resize-none text-lg p-6"
                    />
                    {/* <div className="flex justify-between items-center text-sm text-muted-foreground">
                        <span>7,188 credits remaining</span>
                        <span>{text.length} / 5,000 characters</span>
                    </div> */}
                    <div className="flex gap-2">
                        <Button
                            onClick={handleTextToSpeech}
                            disabled={isLoading || !text.trim()}
                            className="w-full"
                        >
                            {isLoading ? (
                                <>
                                    <ThinkingIndicator size="sm" className="mr-2" />
                                    Generating Audio...
                                </>
                            ) : (
                                <>
                                    <Volume2 className="w-4 h-4 mr-2" />
                                    Generate Speech
                                </>
                            )}
                        </Button>
                    </div>
                </div>
                {/* Right Sidebar */}
                <div className="w-full md:w-[350px] flex-shrink-0 space-y-2">
                    <Tabs defaultValue="settings" className="w-full">
                        <TabsList>
                            <TabsTrigger value="settings">Settings</TabsTrigger>
                            {/* <TabsTrigger value="history">History</TabsTrigger> */}
                        </TabsList>
                        <TabsContent value="settings" className="p-1">
                            <Card className="border-none shadow-none">
                                <CardContent className="space-y-5 pt-6">
                                    <div className="space-y-2">
                                        <Label>Voice</Label>
                                        <VoiceSelector selectedVoice={selectedVoice} onVoiceChange={setSelectedVoice} />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Model</Label>
                                        <Select value={selectedModel} onValueChange={setSelectedModel}>
                                            <SelectTrigger className="h-12">
                                                <SelectValue placeholder="Select a model" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {models.map((model) => (
                                                    <SelectItem key={model.modelId} value={model.modelId}>
                                                        {model.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {/* --- Sliders and Speaker Boost --- */}
                                    {/* Stability */}
                                    <div className="space-y-2">
                                        <div className="flex justify-between"><Label>Stability</Label><span>{voiceSettings.stability.toFixed(2)}</span></div>
                                        <Slider value={[voiceSettings.stability]} onValueChange={([v]) => setVoiceSettings(p => ({ ...p, stability: v }))} max={1} step={0.01} />
                                    </div>
                                    {/* Similarity */}
                                    <div className="space-y-2">
                                        <div className="flex justify-between"><Label>Similarity</Label><span>{voiceSettings.similarity_boost.toFixed(2)}</span></div>
                                        <Slider value={[voiceSettings.similarity_boost]} onValueChange={([v]) => setVoiceSettings(p => ({ ...p, similarity_boost: v }))} max={1} step={0.01} />
                                    </div>
                                    {/* Style Exaggeration */}
                                    <div className="space-y-2">
                                        <div className="flex justify-between"><Label>Style Exaggeration</Label><span>{voiceSettings.style.toFixed(2)}</span></div>
                                        <Slider value={[voiceSettings.style]} onValueChange={([v]) => setVoiceSettings(p => ({ ...p, style: v }))} max={1} step={0.01} />
                                    </div>
                                    {/* Speaker Boost */}
                                    <div className="flex items-center justify-between pt-2">
                                        <Label htmlFor="speaker-boost" className="font-semibold">Speaker boost</Label>
                                        <Switch
                                            id="speaker-boost"
                                            checked={voiceSettings.use_speaker_boost}
                                            onCheckedChange={(c) => setVoiceSettings(p => ({ ...p, use_speaker_boost: c }))}
                                        />
                                    </div>

                                </CardContent>
                            </Card>
                        </TabsContent>
                    </Tabs>
                </div>
            </div>

            {/* Bottom Floating Player */}
            {audioUrl && (
                <div className="fixed bottom-0 left-0 right-0 w-full bg-card border-t z-50">
                    <audio ref={audioRef} src={`${apiClient.apiBaseURL}${audioUrl}`} className="hidden" />
                    <div className="max-w-6xl mx-auto px-4 py-3">
                        <div className="flex items-center gap-4">
                            <div className="flex-grow flex items-center gap-3">
                                <Button variant="ghost" size="icon" onClick={() => handleRewind(10)}><Rewind className="h-5 w-5" /></Button>
                                <Button variant="ghost" size="icon" onClick={playAudio} className="bg-gray-200 dark:bg-gray-700 rounded-full h-9 w-9">
                                    {isPlaying ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
                                </Button>
                                <Button variant="ghost" size="icon" onClick={() => handleRewind(-10)}><FastForward className="h-5 w-5" /></Button>

                                <span className="text-xs text-muted-foreground">{formatTime(currentTime)}</span>
                                <Slider
                                    value={[progress]}
                                    onValueChange={handleSeek} // Allows dragging
                                    className="w-full"
                                />
                                <span className="text-xs text-muted-foreground">{formatTime(duration)}</span>
                            </div>

                            <div className="flex items-center gap-2">
                                <Button variant="ghost" size="icon" onClick={downloadAudio}><Download className="h-4 w-4" /></Button>
                                <Button variant="outline" size="sm" onClick={handleShare}><Share2 className="h-4 w-4 mr-2" />Share</Button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

        </div>
    )
}