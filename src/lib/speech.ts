import { useState, useCallback, useRef, useEffect } from "react"
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition"
import { classifySpeechPermission, mapSpeechError, type SpeechFailureReason } from "./speech-errors"

interface SpeechState {
  listening: boolean
  transcript: string
  error: SpeechFailureReason | null
}

interface SpeechActions {
  start: () => Promise<void>
  stop: () => void
}

export function useSpeech(onResult: (text: string) => void): SpeechState & SpeechActions {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [error, setError] = useState<SpeechFailureReason | null>(null)
  const pending = useRef("")

  useSpeechRecognitionEvent("start", () => {
    setListening(true)
    setError(null)
    setTranscript("")
    pending.current = ""
  })

  useSpeechRecognitionEvent("end", () => {
    setListening(false)
    // Deliver final transcript
    if (pending.current.trim()) {
      onResult(pending.current.trim())
    }
    setTranscript("")
    pending.current = ""
  })

  useSpeechRecognitionEvent("result", (event) => {
    const text = event.results[0]?.transcript || ""
    pending.current = text
    setTranscript(text)
  })

  useSpeechRecognitionEvent("error", (event) => {
    const reason = mapSpeechError(event.error, event.code)
    if (!reason) {
      setListening(false)
      return
    }
    setError(reason)
    setListening(false)
  })

  const start = useCallback(async () => {
    setError(null)
    try {
      const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      const permissionFailure = classifySpeechPermission(result)
      if (permissionFailure) {
        setError(permissionFailure)
        return
      }
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        setError("recognizer-unavailable")
        return
      }
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        interimResults: true,
        continuous: true,
      })
    } catch (error) {
      console.error("Speech recognition failed to start:", error)
      setError("runtime")
    }
  }, [])

  const stop = useCallback(() => {
    ExpoSpeechRecognitionModule.stop()
  }, [])

  // Stop the native recognition session when the screen unmounts — otherwise
  // the mic stays hot in the background. abort() is a no-op when not listening.
  useEffect(() => {
    return () => {
      ExpoSpeechRecognitionModule.abort()
    }
  }, [])

  return { listening, transcript, error, start, stop }
}
