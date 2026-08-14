import { describe, expect, test } from "bun:test"
import { classifySpeechPermission, mapSpeechError } from "./speech-errors"

describe("speech failure classification", () => {
  test("distinguishes denied and permanently blocked permissions", () => {
    expect(classifySpeechPermission({ granted: false, canAskAgain: true })).toBe("permission-denied")
    expect(classifySpeechPermission({ granted: false, canAskAgain: false })).toBe("permission-blocked")
    expect(classifySpeechPermission({ granted: true, canAskAgain: true })).toBeNull()
  })

  test("maps native recognition errors to stable reasons", () => {
    expect(mapSpeechError("service-not-allowed")).toBe("recognizer-unavailable")
    expect(mapSpeechError("unknown", 9)).toBe("permission-denied")
    expect(mapSpeechError("unknown", 3)).toBe("audio-capture")
    expect(mapSpeechError("network")).toBe("network")
  })

  test("ignores intentional abort and no-speech events", () => {
    expect(mapSpeechError("aborted")).toBeNull()
    expect(mapSpeechError("no-speech")).toBeNull()
    expect(mapSpeechError("speech-timeout")).toBeNull()
  })
})
