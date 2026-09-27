import { useMemo, useState, useCallback } from "react"
import { View, Text, TouchableOpacity, StyleSheet } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import BottomSheet, { BottomSheetBackdrop, BottomSheetFlatList, BottomSheetTextInput } from "@gorhom/bottom-sheet"
import { useTranslation } from "react-i18next"
import { useAccent, type AccentState } from "../../lib/accents"
import type { Agent } from "../../lib/sdk"
import { defaultActionDecision } from "../../lib/selection-ui"

interface Props {
  agents: Agent[]
  selected: string
  defaultAgent: string | null
  hasPersistedOverride: boolean
  isDark: boolean
  onSelect: (name: string) => void
  onSelectDefault: () => void
  sheetRef: React.RefObject<BottomSheet | null>
}

export function AgentPicker({ agents, selected, defaultAgent, hasPersistedOverride, isDark, onSelect, onSelectDefault, sheetRef }: Props) {
  const { t } = useTranslation()
  const acc = useAccent()
  const s = makeStyles(acc)
  const [search, setSearch] = useState("")
  // Server-ordered primary/all agents with the effective default first, so the
  // picker highlights the concrete default the way the TUI dialog does.
  const items = useMemo(() => {
    const query = search.toLowerCase()
    const filtered = agents
      .filter((agent) => agent.mode === "primary" || agent.mode === "all")
      .filter((agent) => !query || `${agent.name} ${agent.label || ""} ${agent.description || ""}`.toLowerCase().includes(query))
    if (!defaultAgent) return filtered
    return [...filtered.filter((a) => a.name === defaultAgent), ...filtered.filter((a) => a.name !== defaultAgent)]
  }, [agents, search, defaultAgent])
  const select = useCallback((name: string) => {
    onSelect(name)
    setSearch("")
    sheetRef.current?.close()
  }, [onSelect, sheetRef])
  const action = defaultActionDecision(hasPersistedOverride, !!defaultAgent)
  const defaultAgentName = defaultAgent
    ? agents.find((a) => a.name === defaultAgent)?.label || defaultAgent
    : null
  const isDefaultActive = action === "inherit" ? !selected : selected === defaultAgent
  const defaultRowLabel = action === "concrete"
    ? t("chat.agentPicker.switchDefault", { name: defaultAgentName })
    : defaultAgent
      ? t("chat.agentPicker.useDefault", { name: defaultAgentName })
      : t("chat.agentPicker.useServerDefault")

  return <BottomSheet
    ref={sheetRef}
    index={-1}
    snapPoints={["50%", "80%"]}
    enableDynamicSizing={false}
    enablePanDownToClose
    keyboardBehavior="interactive"
    keyboardBlurBehavior="restore"
    backgroundStyle={isDark ? s.sheetDark : s.sheet}
    handleIndicatorStyle={{ backgroundColor: isDark ? "#666666" : "#cccccc" }}
    backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
    onChange={(index) => { if (index === -1) setSearch("") }}
  >
    <View style={s.header}>
      <Text style={[s.title, isDark && s.textWhite]}>{t("chat.agentPicker.title")}</Text>
      <BottomSheetTextInput style={[s.search, isDark && s.searchDark]} placeholder={t("chat.agentPicker.searchPlaceholder")} placeholderTextColor={isDark ? "#666666" : "#999999"} value={search} onChangeText={setSearch} autoCapitalize="none" />
    </View>
    {action !== "unavailable" && <TouchableOpacity
      style={[s.defaultRow, isDark && s.rowDark, isDefaultActive && s.rowSelected]}
      onPress={() => action === "concrete" ? select(defaultAgent!) : (onSelectDefault(), sheetRef.current?.close())}
      testID="agent-default-option"
      accessibilityRole="button"
      accessibilityState={{ selected: isDefaultActive }}
      accessibilityLabel={action === "concrete" ? defaultRowLabel : t("chat.agentPicker.defaultRowAccessibilityLabel")}
      accessibilityHint={action === "concrete" ? t("chat.agentPicker.switchDefaultAccessibilityHint") : t("chat.agentPicker.defaultRowAccessibilityHint")}
    >
      <Ionicons name="server-outline" size={20} color={acc.cur.accent} />
      <View style={s.rowText}><Text style={[s.name, isDark && s.textWhite]}>{defaultRowLabel}</Text><Text style={[s.description, isDark && s.metaDark]}>{defaultAgent ? t("chat.agentPicker.defaultDescription") : t("chat.agentPicker.useServerDefaultDescription")}</Text></View>
      {isDefaultActive && <Ionicons name="checkmark-circle" size={20} color={acc.cur.accent} />}
    </TouchableOpacity>}
    <BottomSheetFlatList
      data={items}
      keyExtractor={(item: Agent) => item.name}
      renderItem={({ item }: { item: Agent }) => {
        const active = selected === item.name
        return <TouchableOpacity style={[s.row, isDark && s.rowDark, active && (isDark ? s.rowSelectedDark : s.rowSelected)]} onPress={() => select(item.name)} testID={`agent-option-${item.name}`} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={t("chat.agentPicker.rowAccessibilityLabel", { name: item.label || item.name })} accessibilityHint={t("chat.agentPicker.rowAccessibilityHint")}>
          <View style={[s.dot, { backgroundColor: item.color || acc.cur.accent }]} />
          <View style={s.rowText}><Text style={[s.name, isDark && s.textWhite]} numberOfLines={1}>{item.label || item.name}</Text>{item.description && <Text style={[s.description, isDark && s.metaDark]} numberOfLines={2}>{item.description}</Text>}</View>
          {active && <Ionicons name="checkmark-circle" size={20} color={acc.cur.accent} />}
        </TouchableOpacity>
      }}
      contentContainerStyle={s.content}
    />
  </BottomSheet>
}

function makeStyles(acc: AccentState) {
  return StyleSheet.create({
    sheet: { backgroundColor: "#ffffff" }, sheetDark: { backgroundColor: "#1a1a1a" }, header: { paddingHorizontal: 16, paddingBottom: 12, gap: 10 }, title: { fontSize: 18, fontWeight: "700", color: "#0a0a0a" }, textWhite: { color: "#ffffff" }, search: { backgroundColor: "#f5f5f5", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: "#0a0a0a" }, searchDark: { backgroundColor: "#2a2a2a", color: "#ffffff" }, content: { paddingBottom: 40 }, row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#e5e5e5", gap: 12 }, defaultRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 12 }, rowDark: { borderBottomColor: "#2a2a2a" }, rowSelected: { backgroundColor: acc.light.tintBg }, rowSelectedDark: { backgroundColor: "#1f1a2e" }, dot: { width: 10, height: 10, borderRadius: 5 }, rowText: { flex: 1 }, name: { fontSize: 15, fontWeight: "500", color: "#0a0a0a" }, description: { fontSize: 12, color: "#999999", marginTop: 2 }, metaDark: { color: "#666666" },
  })
}
