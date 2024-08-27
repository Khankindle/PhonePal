"use client";

import React, { useEffect, useRef, useState } from "react";
import { usePlayer } from "@/lib/usePlayer";
import { useMicVAD, utils } from "@ricky0123/vad-react";
import { WebPlayer, Cartesia } from "@cartesia/cartesia-js";
import { Phone, Plus, Mic, MicOff } from 'lucide-react';

const languages = [
  { code: "", name: "Not Selected" },
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
];

interface CustomWebSocket extends WebSocket {
  clientId?: string;
}

export default function Home() {
  const [step, setStep] = useState<'initial' | 'joinCall' | 'profile' | 'inCall'>('initial');
  const [selectedLanguage, setSelectedLanguage] = useState("");
  const [userVoiceId, setUserVoiceId] = useState<string | null>(null);
  const [websocket, setWebsocket] = useState<WebSocket | null>(null);
  const [partnerLanguage, setPartnerLanguage] = useState("");
  const [input, setInput] = useState("");

  const player = usePlayer();
  const [audioContexts, setAudioContexts] = useState({});
  const cartesiaPlayer = useRef(new WebPlayer({ bufferDuration: 0.5 }));

  const [callId, setCallId] = useState("");
  const [isInCall, setIsInCall] = useState(false);

  type CartesiaTTSWebSocket = ReturnType<ReturnType<typeof Cartesia.prototype.tts.websocket>>;

  const cartesiaClient = useRef<Cartesia>(new Cartesia({ apiKey: '301dcbc8-7728-4765-b73e-2522cff3c96e' }));
  const ttsWebsocket = useRef<CartesiaTTSWebSocket | null>(null);
  
  const [isPlaying, setIsPlaying] = useState(false);

  const [isMuted, setIsMuted] = useState(false);

  // Queueing logic 
  const [audioQueue, setAudioQueue] = useState([]); // Array that is used as a queue 
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);

  useEffect(() => {
    const initTTSWebsocket = async () => {
      ttsWebsocket.current = cartesiaClient.current.tts.websocket({
        container: "raw",
        encoding: "pcm_f32le",
        sampleRate: 44100
      });
      await ttsWebsocket.current.connect();
    };

    initTTSWebsocket();

    return () => {
      if (ttsWebsocket.current) {
        ttsWebsocket.current.disconnect();
      }
    };
  }, []);

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:3010') as CustomWebSocket;
    setWebsocket(ws);
    
    ws.onopen = () => {
      console.log('Connected to WebSocket server');
      ws.send(JSON.stringify({ type: 'language', language: selectedLanguage }));
      if (userVoiceId) {
        ws.send(JSON.stringify({ type: 'voiceId', voiceId: userVoiceId }));
      }
    };

    ws.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'language') {
            setPartnerLanguage(data.language);
          } else if (data.type === 'callCreated' || data.type === 'callJoined') {
            setCallId(data.callId);
            setIsInCall(true);
            setStep('inCall');
          } else if (data.type === 'translation') {
            console.log("Received translation:", data);
            
            // If get a new translation and there is already one in the queue then don't send next one yet 
            // Add the translation text to a queue instead of the raw audio, then when last one finished call generateAndPlayAudio again 
            // Figure out a way to know when the last one is done playing 

            await generateAndPlayAudio(data.translation, data.voiceId, data.language);

          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      }
    };

    return () => {
      ws.close();
    };
  }, []);

  const generateAndPlayAudio = async (text, voiceId, language) => {
    console.log("language", language)
    console.log("selectedLanguage", selectedLanguage)
    if (!ttsWebsocket.current) return; // Only play if the user is the receiver
    
    console.log("Generating audio for:", text, voiceId, language);
    console.log(language === "en" ? "sonic-english" : "sonic-multilingual")
    const contextId = Date.now().toString();
    const chunks = text.split(/(?<=[.!?])\s+/);
    console.log("chunks::: ", chunks)
    
    setIsPlaying(true);
    // Add to the queue 
    
    try {
      // Send the first chunk and start playing
      const initialResponse = await ttsWebsocket.current.send({
        model_id: language === "en" ? "sonic-english" : "sonic-multilingual",
        voice: { mode: "id", id: voiceId },
        transcript: chunks[0],
        context_id: contextId,
        continue: chunks.length > 1,
        language: language
      });
    
      // Start playing the first chunk
      cartesiaPlayer.current.play(initialResponse.source);
      console.log(chunks[0])
    
      // Send the remaining chunks
    for (let i = 1; i < chunks.length; i++) {
      const response = await ttsWebsocket.current.send({
          model_id: language === "en" ? "sonic-english" : "sonic-multilingual",
          voice: { mode: "id", id: voiceId },
          transcript: chunks[i],
          context_id: contextId,
          continue: i < chunks.length - 1,
          language: language
      });

      /* Here if if i == (chunks.length - 1), i.e. is the last chunk then the 
         last chunk is done processing and we should move to the next item in the queue if there is one. 
         Somehow the queue should be updated from before to call 
      */
   
      // The WebPlayer should automatically handle appending these chunks
      console.log(`Sent chunk ${i + 1}/${chunks.length}`);
      console.log(chunks[i]);
	  }

	} catch (error) {
	  console.error("Error in audio generation or playback:", error);
	} finally {
	  setIsPlaying(false);
	  // This is where we know we can play something else in the queue 
	}
  };

  const vad = useMicVAD({
    startOnLoad: true,
    onSpeechEnd: async (audio) => {
      if (isMuted) return; // Don't process audio if muted
      player.stop();
      const wav = utils.encodeWAV(audio);
      const blob = new Blob([wav], { type: "audio/wav" });
      if (websocket && websocket.readyState === WebSocket.OPEN && isInCall) {
        const formData = new FormData();
        formData.append('audio', blob);
        formData.append('voiceId', userVoiceId || 'a0e99841-438c-4a64-b679-ae501e7d6091');
        formData.append('senderLanguage', selectedLanguage);
        formData.append('receiverLanguage', partnerLanguage || 'es');
        formData.append('callId', callId);

        const response = await fetch(`http://localhost:3010/process-audio`, {
          method: 'POST',
          body: formData
        });

        if (response.ok) {
          const data = await response.json();
          console.log("Received response from server:", data);
        } else {
          console.error('Failed to process audio');
        }
      }
      const isFirefox = navigator.userAgent.includes("Firefox");
      if (isFirefox) vad.pause();
    },		
    workletURL: "/vad.worklet.bundle.min.js",
    modelURL: "/silero_vad.onnx",
    positiveSpeechThreshold: 0.6,
    minSpeechFrames: 4,
    ortConfig(ort) {
      const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
      ort.env.wasm = {
        wasmPaths: {
          "ort-wasm-simd-threaded.wasm": "/ort-wasm-simd-threaded.wasm",
          "ort-wasm-simd.wasm": "/ort-wasm-simd.wasm",
          "ort-wasm.wasm": "/ort-wasm.wasm",
          "ort-wasm-threaded.wasm": "/ort-wasm-threaded.wasm",
          "ort-wasm-simd-threaded.mjs": "/ort-wasm-simd-threaded.mjs", 
        },
        numThreads: isSafari ? 1 : 4,
      };
    },
  });

  const toggleMute = () => {
    setIsMuted(!isMuted);
    if (!isMuted) {
      vad.pause();
    } else {
      vad.start();
    }
  };

  useEffect(() => {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: 'language', language: selectedLanguage }));
    }
  }, [selectedLanguage, websocket]);

  useEffect(() => {
    if (websocket && websocket.readyState === WebSocket.OPEN && userVoiceId) {
      websocket.send(JSON.stringify({ type: 'voiceId', voiceId: userVoiceId }));
    }
  }, [userVoiceId, websocket]);

  const createCall = () => {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: 'createCall' }));
      setStep('profile');
    }
  };

  const joinCall = () => {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: 'joinCall', callId: input }));
      setStep('profile');
    }
  };

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLanguage = e.target.value;
    setSelectedLanguage(newLanguage);
  };

  const handleVoiceClone = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const formData = new FormData();
      formData.append('voiceSample', file);
      const response = await fetch(`http://localhost:3010/clone-voice`, {
        method: 'POST',
        body: formData
      });
      if (response.ok) {
        const { voiceId } = await response.json();
        setUserVoiceId(voiceId);
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          websocket.send(JSON.stringify({ type: 'voiceId', voiceId }));
        }
      } else {
        console.error('Failed to clone voice');
      }
    }
  };

  return (
    <div className="container mx-auto p-4">
      {step === 'initial' && (
        <>
          <header className="text-center mb-8">
            <h1 className="text-4xl font-bold text-blue-600">PhonePal</h1>
          </header>
          <div className="flex justify-center space-x-4">
            <button
              className="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-3 px-6 rounded-lg shadow-md transition duration-300 ease-in-out flex items-center space-x-2"
              onClick={createCall}
            >
              <Plus size={20} />
              <span>Create a Call</span>
            </button>
            <button
              className="bg-green-500 hover:bg-green-600 text-white font-semibold py-3 px-6 rounded-lg shadow-md transition duration-300 ease-in-out flex items-center space-x-2"
              onClick={() => setStep('joinCall')}
            >
              <Phone size={20} />
              <span>Join a Call</span>
            </button>
          </div>
        </>
      )}

      {step === 'joinCall' && (
        <div className="flex flex-col items-center space-y-4">
          <input
            type="text"
            placeholder="Enter Call ID"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="border-2 border-gray-300 bg-white h-12 px-5 rounded-lg text-sm focus:outline-none focus:border-blue-500 w-64"
          />
          <button
            className="bg-green-500 hover:bg-green-600 text-white font-semibold py-3 px-6 rounded-lg shadow-md transition duration-300 ease-in-out flex items-center space-x-2"
            onClick={joinCall}
          >
            <span>Join Call</span>
          </button>
        </div>
      )}

		{(step === 'profile' || step === 'inCall') && (
			<div className="space-y-6">
			{step === 'inCall' && (
				<>
				<div className="bg-white p-6 rounded-lg shadow-md">
					<p className="text-xl font-bold mb-2">In call: {callId}</p>
					<p className="text-md">{vad.userSpeaking && !isMuted ? "Speaking..." : "Not speaking"}</p>
					<button
					onClick={toggleMute}
					className={`mt-2 px-4 py-2 rounded-full flex items-center ${
						isMuted ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600'
					} text-white transition-colors duration-300`}
					>
					{isMuted ? <MicOff size={20} /> : <Mic size={20} />}
					<span className="ml-2">{isMuted ? 'Unmute' : 'Mute'}</span>
					</button>
				</div>
				<div className="bg-green-100 p-6 rounded-lg shadow-md">
          <p className="text-xl font-bold mb-2">{"Partner's language:"}</p>
					<p className="text-lg">{languages.find(lang => lang.code === partnerLanguage)?.name || 'Not selected'}</p>
				</div>
				</>
			)}
		  
          <div className="bg-amber-50 p-6 rounded-lg shadow-md">
            <div className="mb-4">
              <label htmlFor="language-select" className="block text-sm font-medium text-gray-700 mb-2">Select your language: </label>
              <select
                id="language-select"
                value={selectedLanguage}
                onChange={handleLanguageChange}
                className="block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md"
              >
                {languages.map(lang => (
                  <option key={lang.code} value={lang.code}>{lang.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="voice-clone" className="block text-sm font-medium text-gray-700 mb-2">Clone your voice: </label>
              <input
                type="file"
                id="voice-clone"
                accept="audio/*"
                onChange={handleVoiceClone}
                className="block w-full text-sm text-gray-500
                  file:mr-4 file:py-2 file:px-4
                  file:rounded-full file:border-0
                  file:text-sm file:font-semibold
                  file:bg-violet-50 file:text-violet-700
                  hover:file:bg-violet-100"
              />
              {userVoiceId && <p className="mt-2 text-sm text-gray-500">Voice ID: {userVoiceId}</p>}
            </div>
          </div>
          
        </div>
      )}

      {vad.loading && <p className="text-center mt-4">Loading speech detection...</p>}
      {vad.errored && <p className="text-center mt-4 text-red-500">Failed to load speech detection.</p>}

      <div
        className={`absolute size-36 blur-3xl rounded-full bg-gradient-to-b from-blue-200 to-blue-400 dark:from-blue-600 dark:to-blue-800 -z-50 transition ease-in-out ${
          vad.loading || vad.errored
            ? "opacity-0"
            : !vad.userSpeaking
            ? "opacity-30"
            : "opacity-100 scale-110"
        }`}
      />
    </div>
  );
  
}