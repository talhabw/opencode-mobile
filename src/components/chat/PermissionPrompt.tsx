import { useRef, useState } from "react"
import { View, Text, TouchableOpacity, StyleSheet } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import {
  permissionReplyPhaseAfter,
  permissionReplySucceeded,
  type PermissionReply,
  type PermissionReplyPhase,
} from "./permission-prompt"

interface Props {
  permission: { id: string; permission: string; patterns: string[]; message?: string; save?: string[] }
  isDark: boolean
  // A `false` result (or a rejection) means the reply failed and the buttons
  // must become usable again. Handlers may also return nothing (demo flow).
  onReply: (reply: PermissionReply) => void | boolean | Promise<void | boolean>
}

export function PermissionPrompt({ permission, isDark, onReply }: Props) {
  const { t } = useTranslation()
  // The ref is the synchronous double-tap latch; the state drives the disabled
  // styling and recovers the buttons when the reply fails immediately.
  const phaseRef = useRef<PermissionReplyPhase>("idle")
  const [phase, setPhase] = useState<PermissionReplyPhase>("idle")
  const applyPhase = (next: PermissionReplyPhase) => {
    phaseRef.current = next
    setPhase(next)
  }
  const reply = async (value: PermissionReply) => {
    if (phaseRef.current !== "idle") return
    applyPhase("sending")
    let succeeded = false
    try {
      succeeded = permissionReplySucceeded(await onReply(value))
    } catch {
      succeeded = false
    }
    applyPhase(permissionReplyPhaseAfter("sending", succeeded))
  }
  // "Always" persists the tool's proposed patterns (the request's `save`
  // list) as a durable, project-scoped approval, which can differ from the
  // resources this single call touched — shell approvals, for example, save a
  // command prefix. Surface that scope before the user commits to it, and
  // only when it is not the same set already shown above (docs: review broad
  // approvals; Settings lists and revokes the grants saved for this project).
  const save = permission.save ?? []
  const saveDiffersFromPatterns = save.length > 0 && (
    save.length !== permission.patterns.length || save.some((pattern, index) => pattern !== permission.patterns[index])
  )
  const busy = phase !== "idle"
  return (
    <View style={[s.card, isDark && s.cardDark]} testID={`permission-prompt-${permission.id}`}>
      <View style={s.header}>
        <Ionicons name="shield-outline" size={18} color="#f59e0b" />
        <Text style={[s.title, isDark && s.textWhite]}>{t("chat.permissionPrompt.title")}</Text>
      </View>
      <Text style={[s.type, isDark && s.typeDark]}>
        {permission.permission}: {permission.patterns.join(", ")}
      </Text>
      {saveDiffersFromPatterns && (
        <Text style={[s.saveHint, isDark && s.typeDark]}>
          {t("chat.permissionPrompt.alwaysSaves", { patterns: save.join(", ") })}
        </Text>
      )}
      {permission.message && <Text style={[s.message, isDark && s.messageDark]}>{permission.message}</Text>}
      <View style={s.actions}>
        <TouchableOpacity
          style={[s.btn, s.deny, busy && s.btnBusy]}
          onPress={() => { void reply("reject") }}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          testID={`permission-${permission.id}-deny`}
        >
          <Text style={s.denyText}>{t("chat.permissionPrompt.deny")}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.btn, s.always, isDark && s.alwaysDark, busy && s.btnBusy]}
          onPress={() => { void reply("always") }}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          testID={`permission-${permission.id}-always`}
        >
          <Text style={[s.alwaysText, isDark && s.textWhite]}>{t("chat.permissionPrompt.always")}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.btn, s.allow, isDark && s.allowDark, busy && s.btnBusy]}
          onPress={() => { void reply("once") }}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          testID={`permission-${permission.id}-allow`}
        >
          <Text style={[s.allowText, isDark && s.allowTextDark]}>{t("chat.permissionPrompt.allow")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  card: {
    margin: 12,
    padding: 16,
    backgroundColor: "#fffbeb",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#fef3c7",
  },
  cardDark: { backgroundColor: "#1a1800", borderColor: "#333300" },
  header: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  title: { fontSize: 15, fontWeight: "600", color: "#92400e" },
  textWhite: { color: "#ffffff" },
  type: { fontSize: 13, color: "#78350f", marginBottom: 12 },
  typeDark: { color: "#d4a574" },
  saveHint: { fontSize: 12, color: "#92400e", marginTop: -6, marginBottom: 12 },
  message: { fontSize: 13, lineHeight: 18, color: "#78350f", marginTop: -6, marginBottom: 12 },
  messageDark: { color: "#d4a574" },
  actions: { flexDirection: "row", gap: 8 },
  btn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center" },
  btnBusy: { opacity: 0.5 },
  deny: { backgroundColor: "#fef2f2" },
  denyText: { color: "#dc2626", fontWeight: "600", fontSize: 14 },
  always: { backgroundColor: "#f5f5f5" },
  alwaysDark: { backgroundColor: "#2a2a2a" },
  alwaysText: { color: "#0a0a0a", fontWeight: "600", fontSize: 14 },
  allow: { backgroundColor: "#0a0a0a" },
  allowDark: { backgroundColor: "#ffffff" },
  allowText: { color: "#ffffff", fontWeight: "600", fontSize: 14 },
  allowTextDark: { color: "#0a0a0a" },
})
