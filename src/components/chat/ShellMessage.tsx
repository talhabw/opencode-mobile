import { View, Text, ScrollView, StyleSheet, Platform } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import type { Message } from "../../lib/sdk"
import { useAccent } from "../../lib/accents"

const mono = Platform.OS === "ios" ? "Menlo" : "monospace"

function statusColor(status: NonNullable<Message["shell"]>["status"]): string {
  if (status === "exited" || status === "completed") return "#22c55e"
  if (status === "running") return "#f59e0b"
  if (status === "cancelled") return "#888888"
  return "#ef4444"
}

function duration(created: number, completed?: number): string | undefined {
  if (completed === undefined || completed < created) return undefined
  const elapsed = completed - created
  return elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`
}

export function ShellMessage({ message, isDark }: { message: Message; isDark: boolean }) {
  const { t } = useTranslation()
  const shell = message.shell
  const acc = useAccent()
  if (!shell) return null
  const color = statusColor(shell.status)
  const elapsed = duration(shell.time.created, shell.time.completed)
  const output = shell.output?.output ?? ""
  const exit = shell.exit === undefined ? "" : ` · exit ${String(shell.exit)}`

  return (
    <View style={[styles.row, isDark && styles.rowDark]} testID="chat-shell-message">
      <View style={styles.header}>
        <Ionicons name="terminal-outline" size={15} color={color} />
        <Text style={[styles.label, isDark && styles.textDark]}>{t("chat.shellMessage.label")}</Text>
        <Text style={[styles.status, { color }]}>{t(`chat.shellMessage.status.${shell.status}`)}{exit}</Text>
        {elapsed && <Text style={[styles.meta, isDark && styles.metaDark]}>{elapsed}</Text>}
      </View>
      <Text style={[styles.command, isDark && styles.commandDark]} numberOfLines={3} selectable>
        <Text style={{ color: acc.cur.accent }}>$ </Text>{shell.command || t("chat.shellMessage.emptyCommand")}
      </Text>
      {output.length > 0 && (
        <ScrollView style={styles.outputScroll} nestedScrollEnabled>
          <Text style={[styles.output, isDark && styles.outputDark]} selectable>{output}</Text>
        </ScrollView>
      )}
      {shell.output?.truncated && <Text style={[styles.truncated, isDark && styles.metaDark]}>{t("chat.shellMessage.outputTruncated")}</Text>}
      {/* Cursor semantics belong to real shell message records; synthetic
          completion markers carry plain output without a cursor. */}
      {shell.output && shell.exit !== undefined && (
        <Text style={[styles.meta, isDark && styles.metaDark]}>cursor {shell.output.cursor} / {shell.output.size}</Text>
      )}
    </View>
  )
}

export function SystemMessage({ message, parts, isDark }: { message: Message; parts: Array<{ type: string; text?: string }>; isDark: boolean }) {
  const text = parts.filter((part) => part.type === "text").map((part) => part.text).filter(Boolean).join("\n")
  if (!text) return null
  return (
    <View style={[styles.system, isDark && styles.rowDark]} testID="chat-system-message">
      <Ionicons name="information-circle-outline" size={14} color={isDark ? "#999999" : "#777777"} />
      <Text style={[styles.systemText, isDark && styles.textDark]} selectable>{text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { marginBottom: 12, padding: 9, borderLeftWidth: 2, borderLeftColor: "#f59e0b", backgroundColor: "#fafafa" },
  rowDark: { backgroundColor: "#171717", borderLeftColor: "#b7791f" },
  header: { flexDirection: "row", alignItems: "center", gap: 6 },
  label: { fontSize: 12, fontWeight: "600", color: "#333333" },
  status: { fontSize: 11, flex: 1 },
  meta: { fontSize: 10, color: "#888888" },
  metaDark: { color: "#777777" },
  textDark: { color: "#dddddd" },
  command: { marginTop: 7, fontFamily: mono, fontSize: 12, lineHeight: 17, color: "#222222" },
  commandDark: { color: "#dddddd" },
  outputScroll: { maxHeight: 180, marginTop: 7, padding: 7, backgroundColor: "#f0f0f0" },
  output: { fontFamily: mono, fontSize: 11, lineHeight: 16, color: "#222222" },
  outputDark: { color: "#dddddd" },
  truncated: { marginTop: 5, fontSize: 10, color: "#d97706" },
  system: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginBottom: 10, paddingVertical: 4 },
  systemText: { flex: 1, fontSize: 12, lineHeight: 17, color: "#666666" },
})
