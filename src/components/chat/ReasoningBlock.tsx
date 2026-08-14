import { useState } from "react"
import { View, Text, TouchableOpacity, StyleSheet } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"

interface Props {
  text: string
  isDark: boolean
  /** Stable identifier reported to onToggleExpand (e.g. the owning message id). */
  id?: string
  /**
   * Fired with the NEW expanded state right before the row's layout change
   * lands, so the transcript can anchor the header. Must be stable across
   * renders (useCallback in the screen) to keep MessageBubble's memo correct.
   */
  onToggleExpand?: (id: string, expanded: boolean) => void
}

export function ReasoningBlock({ text, isDark, id, onToggleExpand }: Props) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  return (
    <TouchableOpacity
      style={[s.block, isDark && s.blockDark]}
      onPress={() => {
        const next = !expanded
        setExpanded(next)
        onToggleExpand?.(id ?? "", next)
      }}
      activeOpacity={0.7}
    >
      <View style={s.header}>
        <Ionicons name="bulb-outline" size={14} color="#f59e0b" />
        <Text style={[s.label, isDark && s.labelDark]}>{t("chat.reasoningBlock.label")}</Text>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={14} color={isDark ? "#666666" : "#999999"} />
      </View>
      {expanded && (
        <Text style={[s.text, isDark && s.textDark]} selectable>
          {text}
        </Text>
      )}
    </TouchableOpacity>
  )
}

const s = StyleSheet.create({
  block: {
    backgroundColor: "#fffbeb",
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#fef3c7",
  },
  blockDark: { backgroundColor: "#1a1a0a", borderColor: "#333300" },
  header: { flexDirection: "row", alignItems: "center", gap: 6 },
  label: { fontSize: 12, fontWeight: "600", color: "#92400e", flex: 1 },
  labelDark: { color: "#f59e0b" },
  text: { fontSize: 13, lineHeight: 20, color: "#78350f", marginTop: 8 },
  textDark: { color: "#d4a574" },
})
