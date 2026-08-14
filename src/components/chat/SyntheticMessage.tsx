import { useState } from "react"
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { router } from "expo-router"
import type { Message } from "../../lib/sdk"
import { useAccent, type AccentState } from "../../lib/accents"
import { findCachedSession } from "../../lib/session-hierarchy"
import { useSessions } from "../../stores/sessions"
import { useConnections } from "../../stores/connections"

function stateColor(state: NonNullable<Message["subagent"]>["state"]): string {
  if (state === "completed") return "#22c55e"
  if (state === "error") return "#ef4444"
  return "#888888"
}

export function SubagentMessage({ message, isDark }: { message: Message; isDark: boolean }) {
  const { t } = useTranslation()
  const acc = useAccent()
  const s = makeStyles(acc)
  const [opening, setOpening] = useState(false)
  const subagent = message.subagent
  if (!subagent) return null
  const color = stateColor(subagent.state)

  const open = async () => {
    if (opening) return
    setOpening(true)
    try {
      const state = useSessions.getState()
      let session = findCachedSession(subagent.refID, state.sessions, state.childrenByParent, state.currentSession)
      if (!session) {
        const parent = findCachedSession(message.sessionID, state.sessions, state.childrenByParent, state.currentSession)
        const directory = parent?.directory
        const connections = useConnections.getState()
        const client = directory ? connections.clientForDirectory(directory) : connections.client
        if (!client) return
        const fetched = await client.session.get(subagent.refID)
        if (fetched.id !== subagent.refID) return
        session = fetched
        state.handleEvent({ type: "session.updated", properties: { info: fetched } })
      }
      router.push({ pathname: "/session/[id]", params: { id: session.id, ...(session.directory ? { directory: session.directory } : {}) } })
    } catch (error) {
      console.warn("Failed to open subagent session:", error)
    } finally {
      setOpening(false)
    }
  }

  return (
    <View style={[s.row, isDark && s.rowDark]} testID="chat-subagent-message">
      <View style={s.header}>
        <Ionicons name="git-branch-outline" size={15} color={color} />
        <Text style={[s.description, isDark && s.textDark]} numberOfLines={2} selectable>
          {subagent.description || t("chat.subagentMessage.title")}
        </Text>
      </View>
      <View style={s.statusRow}>
        <Text style={[s.status, { color }]}>{t(`chat.subagentMessage.status.${subagent.state}`)}</Text>
        <TouchableOpacity
          style={s.openButton}
          onPress={open}
          disabled={opening}
          accessibilityRole="button"
          accessibilityLabel={t("chat.toolCallCard.openSubagent")}
          testID={`open-subagent-${subagent.refID}`}
        >
          {opening
            ? <ActivityIndicator size="small" color={acc.cur.primary} />
            : <Text style={s.openText}>{t("chat.toolCallCard.openSubagent")}</Text>}
        </TouchableOpacity>
      </View>
      {subagent.result && (
        <Text style={[s.result, isDark && s.resultDark]} numberOfLines={6} selectable>
          {subagent.result}
        </Text>
      )}
    </View>
  )
}

function makeStyles(acc: AccentState) {
  return StyleSheet.create({
    row: { marginBottom: 12, padding: 9, borderLeftWidth: 2, borderLeftColor: acc.cur.primary, backgroundColor: "#fafafa" },
    rowDark: { backgroundColor: "#171717" },
    header: { flexDirection: "row", alignItems: "center", gap: 6 },
    description: { flex: 1, fontSize: 12, lineHeight: 17, color: "#333333" },
    textDark: { color: "#dddddd" },
    statusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 7 },
    status: { fontSize: 11, flex: 1 },
    openButton: { minHeight: 32, justifyContent: "center", paddingHorizontal: 10 },
    openText: { color: acc.cur.primary, fontSize: 13, fontWeight: "700" },
    result: { marginTop: 7, fontSize: 12, lineHeight: 17, color: "#444444" },
    resultDark: { color: "#bbbbbb" },
  })
}
