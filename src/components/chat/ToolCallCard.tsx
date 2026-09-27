import { useState, useCallback, useRef } from "react"
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView, Platform } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { router } from "expo-router"
import type { Part } from "../../lib/sdk"
import { useAccent, type AccentState } from "../../lib/accents"
import { DiffView } from "./DiffView"
import { taskSubagentLink } from "../../lib/task-subagent"
import { findCachedSession } from "../../lib/session-hierarchy"
import { useSessions } from "../../stores/sessions"
import { useConnections } from "../../stores/connections"
import { useEvents } from "../../stores/events"

const EMPTY_PENDING_QUESTIONS: [] = []

const TOOL_ICONS: Record<string, string> = {
  read: "glasses-outline",
  list: "list-outline",
  glob: "search-outline",
  grep: "search-outline",
  webfetch: "globe-outline",
  edit: "code-slash-outline",
  write: "create-outline",
  apply_patch: "git-merge-outline",
  bash: "terminal-outline",
  shell: "terminal-outline",
  task: "git-branch-outline",
  todowrite: "checkbox-outline",
  todoread: "checkbox-outline",
  question: "chatbubble-ellipses-outline",
  codesearch: "search-outline",
  websearch: "globe-outline",
}

const mono = Platform.OS === "ios" ? "Menlo" : "monospace"

function statusColor(status: string): string {
  if (status === "completed") return "#22c55e"
  if (status === "error") return "#ef4444"
  if (status === "running") return "#f59e0b"
  return "#888888"
}

// --- Tool-specific detail renderers ---

function BashDetail({ input, output, isDark }: { input: unknown; output: unknown; isDark: boolean }) {
  const acc = useAccent()
  const s = makeStyles(acc)
  const cmd = typeof input === "object" && input !== null ? (input as Record<string, unknown>).command : undefined
  const out = typeof output === "string" ? output : undefined
  return (
    <View style={s.detailSection}>
      {typeof cmd === "string" && (
        <View style={[s.codeBlock, isDark && s.codeBlockDark]}>
          <Text style={[s.codePre, isDark && s.codePteDark]} selectable>
            <Text style={s.codePrompt}>$ </Text>
            {cmd}
          </Text>
        </View>
      )}
      {out !== undefined && out.length > 0 && (
        <View style={[s.codeBlock, isDark && s.codeBlockDark, { marginTop: 6 }]}>
          <Text style={[s.codePre, isDark && s.codePteDark]} selectable numberOfLines={80}>
            {out}
          </Text>
        </View>
      )}
    </View>
  )
}

function ReadDetail({ input, output, isDark }: { input: unknown; output: unknown; isDark: boolean }) {
  const acc = useAccent()
  const s = makeStyles(acc)
  const file = typeof input === "object" && input !== null ? (input as Record<string, unknown>).filePath : undefined
  const offset = typeof input === "object" && input !== null ? (input as Record<string, unknown>).offset : undefined
  const limit = typeof input === "object" && input !== null ? (input as Record<string, unknown>).limit : undefined
  const range = offset || limit ? ` (${offset || 0}..${limit || "end"})` : ""
  const out = typeof output === "string" ? output : undefined
  return (
    <View style={s.detailSection}>
      {typeof file === "string" && (
        <Text style={[s.detailFile, isDark && s.detailFileDark]} selectable numberOfLines={2}>
          {file}
          {range}
        </Text>
      )}
      {out !== undefined && out.length > 0 && (
        <View style={[s.codeBlock, isDark && s.codeBlockDark, { marginTop: 6 }]}>
          <Text style={[s.codePre, isDark && s.codePteDark]} selectable numberOfLines={80}>
            {out}
          </Text>
        </View>
      )}
    </View>
  )
}

function WriteDetail({ input, isDark }: { input: unknown; isDark: boolean }) {
  const acc = useAccent()
  const s = makeStyles(acc)
  const file = typeof input === "object" && input !== null ? (input as Record<string, unknown>).filePath : undefined
  const content = typeof input === "object" && input !== null ? (input as Record<string, unknown>).content : undefined
  return (
    <View style={s.detailSection}>
      {typeof file === "string" && (
        <Text style={[s.detailFile, isDark && s.detailFileDark]} selectable numberOfLines={2}>
          {file}
        </Text>
      )}
      {typeof content === "string" && content.length > 0 && (
        <View style={[s.codeBlock, isDark && s.codeBlockDark, { marginTop: 6 }]}>
          <Text style={[s.codePre, isDark && s.codePteDark]} selectable numberOfLines={40}>
            {content}
          </Text>
        </View>
      )}
    </View>
  )
}

function EditDetail({ input, output, isDark }: { input: unknown; output: unknown; isDark: boolean }) {
  const acc = useAccent()
  const s = makeStyles(acc)
  const file = typeof input === "object" && input !== null ? (input as Record<string, unknown>).filePath : undefined
  const old = typeof input === "object" && input !== null ? (input as Record<string, unknown>).oldString : undefined
  const replacement =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>).newString : undefined

  // If we have old/new strings, show as diff
  if (typeof old === "string" && typeof replacement === "string") {
    return (
      <View style={s.detailSection}>
        {typeof file === "string" && (
          <Text style={[s.detailFile, isDark && s.detailFileDark]} selectable numberOfLines={2}>
            {file}
          </Text>
        )}
        <DiffView before={old} after={replacement} isDark={isDark} />
      </View>
    )
  }

  // Fallback: show raw output
  const text = typeof output === "string" ? output : JSON.stringify(output, null, 2)
  return (
    <View style={s.detailSection}>
      {typeof file === "string" && (
        <Text style={[s.detailFile, isDark && s.detailFileDark]} selectable numberOfLines={2}>
          {file}
        </Text>
      )}
      {text && (
        <View style={[s.codeBlock, isDark && s.codeBlockDark, { marginTop: 6 }]}>
          <Text style={[s.codePre, isDark && s.codePteDark]} selectable numberOfLines={40}>
            {text}
          </Text>
        </View>
      )}
    </View>
  )
}

function PatchDetail({ input, isDark }: { input: unknown; isDark: boolean }) {
  const acc = useAccent()
  const s = makeStyles(acc)
  const patch = typeof input === "object" && input !== null ? (input as Record<string, unknown>).patch : undefined
  return (
    <View style={s.detailSection}>
      {typeof patch === "string" && patch.length > 0 && (
        <View style={[s.codeBlock, isDark && s.codeBlockDark]}>
          <Text style={[s.codePre, isDark && s.codePteDark]} selectable numberOfLines={60}>
            {patch}
          </Text>
        </View>
      )}
    </View>
  )
}

function GlobGrepDetail({ input, output, isDark }: { input: unknown; output: unknown; isDark: boolean }) {
  const { t } = useTranslation()
  const acc = useAccent()
  const s = makeStyles(acc)
  const pattern = typeof input === "object" && input !== null ? (input as Record<string, unknown>).pattern : undefined
  const path = typeof input === "object" && input !== null ? (input as Record<string, unknown>).path : undefined
  const results = typeof output === "string" ? output : undefined
  return (
    <View style={s.detailSection}>
      {typeof pattern === "string" && (
        <Text style={[s.detailMeta, isDark && s.detailMetaDark]}>
          {typeof path === "string"
            ? t("chat.toolCallCard.patternWithPath", { pattern, path })
            : t("chat.toolCallCard.patternOnly", { pattern })}
        </Text>
      )}
      {results && results.length > 0 && (
        <View style={[s.codeBlock, isDark && s.codeBlockDark, { marginTop: 6 }]}>
          <Text style={[s.codePre, isDark && s.codePteDark]} selectable numberOfLines={30}>
            {results}
          </Text>
        </View>
      )}
    </View>
  )
}

function WebfetchDetail({ input, isDark }: { input: unknown; isDark: boolean }) {
  const acc = useAccent()
  const s = makeStyles(acc)
  const url = typeof input === "object" && input !== null ? (input as Record<string, unknown>).url : undefined
  return (
    <View style={s.detailSection}>
      {typeof url === "string" && (
        <Text style={[s.detailFile, isDark && s.detailFileDark, { color: acc.cur.accent }]} selectable numberOfLines={3}>
          {url}
        </Text>
      )}
    </View>
  )
}

function TaskDetail({ input, isDark }: { input: unknown; isDark: boolean }) {
  const acc = useAccent()
  const s = makeStyles(acc)
  const description =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>).description : undefined
  const prompt = typeof input === "object" && input !== null ? (input as Record<string, unknown>).prompt : undefined
  return (
    <View style={s.detailSection}>
      {typeof description === "string" && <Text style={[s.detailMeta, isDark && s.detailMetaDark]}>{description}</Text>}
      {typeof prompt === "string" && prompt.length > 0 && (
        <View style={[s.codeBlock, isDark && s.codeBlockDark, { marginTop: 6 }]}>
          <Text style={[s.codePre, isDark && s.codePteDark]} selectable numberOfLines={20}>
            {prompt}
          </Text>
        </View>
      )}
    </View>
  )
}

function TodoDetail({ input, isDark }: { input: unknown; isDark: boolean }) {
  const acc = useAccent()
  const s = makeStyles(acc)
  const todos = typeof input === "object" && input !== null ? (input as Record<string, unknown>).todos : undefined
  if (!Array.isArray(todos)) return null
  return (
    <View style={s.detailSection}>
      {todos.map((t, i) => {
        const item = t as Record<string, unknown>
        const done = item.status === "completed"
        return (
          <View key={String(item.id || i)} style={s.todoRow}>
            <Ionicons
              name={done ? "checkbox" : "square-outline"}
              size={16}
              color={done ? "#22c55e" : isDark ? "#666666" : "#999999"}
            />
            <Text style={[s.todoText, isDark && s.todoTextDark, done && s.todoDone]} numberOfLines={2}>
              {String(item.content || item.title || "")}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

function GenericDetail({ input, output, isDark }: { input: unknown; output: unknown; isDark: boolean }) {
  const acc = useAccent()
  const s = makeStyles(acc)
  const text =
    typeof output === "string"
      ? output
      : output !== undefined && output !== null
        ? JSON.stringify(output, null, 2)
        : typeof input === "object" && input !== null
          ? JSON.stringify(input, null, 2)
          : undefined
  if (!text || text.length === 0) return null
  return (
    <View style={s.detailSection}>
      <View style={[s.codeBlock, isDark && s.codeBlockDark]}>
        <Text style={[s.codePre, isDark && s.codePteDark]} selectable numberOfLines={30}>
          {text}
        </Text>
      </View>
    </View>
  )
}

function ToolDetail({ tool, isDark }: { tool: Part; isDark: boolean }) {
  const name = tool.tool || ""
  const input = tool.state?.input
  const output = tool.state?.output

  switch (name) {
    case "bash":
    case "shell":
      return <BashDetail input={input} output={output} isDark={isDark} />
    case "read":
      return <ReadDetail input={input} output={output} isDark={isDark} />
    case "write":
      return <WriteDetail input={input} isDark={isDark} />
    case "edit":
      return <EditDetail input={input} output={output} isDark={isDark} />
    case "apply_patch":
      return <PatchDetail input={input} isDark={isDark} />
    case "glob":
    case "grep":
    case "list":
    case "codesearch":
      return <GlobGrepDetail input={input} output={output} isDark={isDark} />
    case "webfetch":
    case "websearch":
      return <WebfetchDetail input={input} isDark={isDark} />
    case "task":
      return <TaskDetail input={input} isDark={isDark} />
    case "todowrite":
      return <TodoDetail input={input} isDark={isDark} />
    default:
      return <GenericDetail input={input} output={output} isDark={isDark} />
  }
}

// --- Error display ---
function ErrorBanner({ message, isDark }: { message: string; isDark: boolean }) {
  const acc = useAccent()
  const s = makeStyles(acc)
  return (
    <View style={[s.errorBanner, isDark && s.errorBannerDark]}>
      <Ionicons name="alert-circle" size={14} color="#ef4444" />
      <Text style={s.errorText} numberOfLines={3} selectable>
        {message}
      </Text>
    </View>
  )
}

// --- Duration display ---
function duration(start?: number, end?: number): string | null {
  if (!start || !end) return null
  const ms = end - start
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// --- Main component ---
interface Props {
  tool: Part
  isDark: boolean
  /**
   * Fired with the NEW expanded state right before the row's layout change
   * lands, plus the card's last measured height (the pre-tap height, captured
   * by the card's own onLayout), so the transcript can anchor the header.
   * Must be stable across renders (useCallback in the screen) to keep
   * MessageBubble's memo correct.
   */
  onToggleExpand?: (id: string, expanded: boolean, height: number | null) => void
  /**
   * Fired with this card's measured layout height on every size change, so
   * the screen can attribute expansion deltas to THIS card (and only this
   * card) while an expansion anchor is pending. Must be stable across
   * renders for the same reason as onToggleExpand.
   */
  onLayout?: (id: string, height: number) => void
}

function TaskSubagentCard({ tool, isDark, onToggleExpand, onLayout }: Props) {
  const { t } = useTranslation()
  const acc = useAccent()
  const s = makeStyles(acc)
  const [expanded, setExpanded] = useState(false)
  const [opening, setOpening] = useState(false)
  const heightRef = useRef<number | null>(null)
  const link = taskSubagentLink(tool)
  const pendingQuestions = useEvents((state) => link ? state.questions[link.sessionID] ?? EMPTY_PENDING_QUESTIONS : EMPTY_PENDING_QUESTIONS)
  const input = tool.state?.input && typeof tool.state.input === "object" ? tool.state.input as Record<string, unknown> : {}
  const agentName = typeof input.agent === "string" ? input.agent : undefined
  const subagentType = typeof input.subagent_type === "string" ? input.subagent_type : undefined
  const agent = [agentName, subagentType].filter((value, index, values) => value && values.indexOf(value) === index).join(" · ") || undefined
  const summary = typeof input.summary === "string" ? input.summary : typeof input.description === "string" ? input.description : undefined
  const result = tool.state?.output
  const status = tool.state?.status ?? "pending"

  const open = async () => {
    if (!link || opening) return
    setOpening(true)
    try {
      const state = useSessions.getState()
      let session = findCachedSession(link.sessionID, state.sessions, state.childrenByParent, state.currentSession)
      if (!session) {
        const parent = link.parentSessionID
          ? findCachedSession(link.parentSessionID, state.sessions, state.childrenByParent, state.currentSession)
          : state.currentSession
        const directory = parent?.directory
        const connections = useConnections.getState()
        const client = directory ? connections.clientForDirectory(directory) : connections.client
        if (!client) return
        const fetched = await client.session.get(link.sessionID)
        if (fetched.id !== link.sessionID) return
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
    <View
      style={[s.card, s.taskCard, isDark && s.cardDark]}
      testID={`task-card-${tool.id}`}
      onLayout={(e) => {
        const h = Math.round(e.nativeEvent.layout.height)
        heightRef.current = h
        onLayout?.(tool.id, h)
      }}
    >
      <TouchableOpacity
        style={s.header}
        onPress={() => {
          const next = !expanded
          setExpanded(next)
          onToggleExpand?.(tool.id, next, heightRef.current)
        }}
        accessibilityRole="button"
        accessibilityLabel={summary || t("chat.toolCallCard.taskTitle")}
        accessibilityState={{ expanded }}
      >
        <View style={s.headerLeft}>
          <Ionicons name="git-branch-outline" size={16} color={statusColor(status)} />
          <View style={s.taskHeading}>
            <Text style={[s.name, isDark && s.nameDark]} numberOfLines={1}>{summary || t("chat.toolCallCard.taskTitle")}</Text>
            {agent && <Text style={[s.taskAgent, isDark && s.elapsedDark]} numberOfLines={1}>{agent}</Text>}
          </View>
        </View>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={16} color={isDark ? "#888888" : "#666666"} />
      </TouchableOpacity>
      <View style={s.taskStatusRow}>
        <Text style={[s.detailMeta, isDark && s.detailMetaDark]}>{t(`chat.toolCallCard.taskStatus.${status}`)}</Text>
        {link && (
          <TouchableOpacity
            style={s.openTaskButton}
            onPress={open}
            disabled={opening}
            accessibilityRole="button"
            accessibilityLabel={pendingQuestions.length > 0
              ? t("chat.toolCallCard.inputNeeded", { count: pendingQuestions.length })
              : t("chat.toolCallCard.openSubagent")}
            testID={`open-subagent-${link.sessionID}`}
          >
            {opening ? <ActivityIndicator size="small" color={acc.cur.primary} /> : (
              <View style={s.taskActionContent}>
                {pendingQuestions.length > 0 && <Text style={[s.pendingTaskText, { color: acc.cur.primary }]}>{t("chat.toolCallCard.inputNeeded", { count: pendingQuestions.length })}</Text>}
                <Text style={s.openTaskText}>{t("chat.toolCallCard.openSubagent")}</Text>
              </View>
            )}
          </TouchableOpacity>
        )}
      </View>
      {expanded && (
        <View style={s.detailSection}>
          {typeof input.prompt === "string" && <Text style={[s.detailMeta, isDark && s.detailMetaDark]} selectable>{input.prompt}</Text>}
          {result !== undefined && <GenericDetail input={undefined} output={result} isDark={isDark} />}
          {tool.state?.error?.message && <ErrorBanner message={tool.state.error.message} isDark={isDark} />}
        </View>
      )}
    </View>
  )
}

export function ToolCallCard({ tool, isDark, onToggleExpand, onLayout }: Props) {
  const { t } = useTranslation()
  const acc = useAccent()
  const s = makeStyles(acc)
  const [expanded, setExpanded] = useState(false)
  const heightRef = useRef<number | null>(null)
  const icon = (tool.tool && TOOL_ICONS[tool.tool]) || "extension-puzzle-outline"
  const status = tool.state?.status || "pending"
  const color = statusColor(status)
  const error = tool.state?.error?.message
  const elapsed = duration(tool.state?.time?.start, tool.state?.time?.end)
  const hasDetail = tool.state?.input !== undefined || tool.state?.output !== undefined || error

  const toggle = useCallback(() => {
    if (!hasDetail) return
    const next = !expanded
    setExpanded(next)
    onToggleExpand?.(tool.id, next, heightRef.current)
  }, [hasDetail, expanded, tool.id, onToggleExpand])

  if (tool.tool === "task") return <TaskSubagentCard tool={tool} isDark={isDark} onToggleExpand={onToggleExpand} onLayout={onLayout} />

  return (
    <TouchableOpacity
      style={[
        s.card,
        isDark && s.cardDark,
        status === "error" && s.cardError,
        status === "error" && isDark && s.cardErrorDark,
      ]}
      onPress={toggle}
      activeOpacity={hasDetail ? 0.7 : 1}
      onLayout={(e) => {
        const h = Math.round(e.nativeEvent.layout.height)
        heightRef.current = h
        onLayout?.(tool.id, h)
      }}
    >
      {/* Header row */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Ionicons name={icon as any} size={16} color={color} />
          <Text style={[s.name, isDark && s.nameDark]} numberOfLines={1}>
            {tool.state?.title || tool.tool || t("chat.toolCallCard.fallbackTitle")}
          </Text>
          {elapsed && <Text style={[s.elapsed, isDark && s.elapsedDark]}>{elapsed}</Text>}
        </View>
        <View style={s.headerRight}>
          {status === "running" && <ActivityIndicator size="small" color={color} />}
          {status === "completed" && <Ionicons name="checkmark-circle" size={16} color="#22c55e" />}
          {status === "error" && <Ionicons name="close-circle" size={16} color="#ef4444" />}
          {hasDetail && (
            <Ionicons
              name={expanded ? "chevron-up" : "chevron-down"}
              size={16}
              color={isDark ? "#666666" : "#999999"}
            />
          )}
        </View>
      </View>

      {/* Error banner */}
      {error && !expanded && <ErrorBanner message={error} isDark={isDark} />}

      {/* Expanded detail */}
      {expanded && (
        <ScrollView style={s.detailScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
          {error && <ErrorBanner message={error} isDark={isDark} />}
          <ToolDetail tool={tool} isDark={isDark} />
        </ScrollView>
      )}
    </TouchableOpacity>
  )
}

function makeStyles(acc: AccentState) {
  return StyleSheet.create({
    card: {
      backgroundColor: "#ffffff",
      padding: 10,
      borderRadius: 8,
      marginTop: 8,
      borderWidth: 1,
      borderColor: "#f0f0f0",
    },
    cardDark: { backgroundColor: "#2a2a2a", borderColor: "#3a3a3a" },
    taskCard: { borderLeftWidth: 3, borderLeftColor: acc.cur.primary },
    cardError: { borderColor: "#fecaca" },
    cardErrorDark: { borderColor: "#7f1d1d" },

    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    taskHeading: { flex: 1 },
    taskAgent: { fontSize: 11, color: "#777777", marginTop: 2 },
    taskStatusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
    taskActionContent: { alignItems: "flex-end" },
    pendingTaskText: { fontSize: 11, fontWeight: "600", marginBottom: 2 },
    openTaskButton: { minHeight: 40, justifyContent: "center", paddingHorizontal: 10 },
    openTaskText: { color: acc.cur.primary, fontSize: 13, fontWeight: "700" },
    headerLeft: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
    headerRight: { flexDirection: "row", alignItems: "center", gap: 6 },
    name: { fontSize: 13, fontWeight: "500", color: "#0a0a0a", flex: 1 },
    nameDark: { color: "#e5e5e5" },
    elapsed: { fontSize: 11, color: "#999999" },
    elapsedDark: { color: "#666666" },

    // Error
    errorBanner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
      marginTop: 8,
      padding: 8,
      backgroundColor: "#fef2f2",
      borderRadius: 6,
    },
    errorBannerDark: { backgroundColor: "#1a0a0a" },
    errorText: { fontSize: 12, color: "#dc2626", flex: 1, lineHeight: 18 },

    // Detail
    detailScroll: { maxHeight: 300, marginTop: 8 },
    detailSection: { gap: 4 },
    detailFile: {
      fontSize: 12,
      fontFamily: mono,
      color: acc.light.primary,
      backgroundColor: acc.light.tintBg,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 4,
      overflow: "hidden",
    },
    detailFileDark: { color: acc.dark.soft, backgroundColor: acc.dark.tintSurface },
    detailMeta: { fontSize: 12, color: "#666666", lineHeight: 18 },
    detailMetaDark: { color: "#888888" },

    // Code block
    codeBlock: {
      backgroundColor: "#f8f8f8",
      borderRadius: 6,
      padding: 10,
    },
    codeBlockDark: { backgroundColor: "#1a1a1a" },
    codePre: {
      fontSize: 12,
      fontFamily: mono,
      color: "#0a0a0a",
      lineHeight: 18,
    },
    codePteDark: { color: "#e5e5e5" },
    codePrompt: { color: acc.light.accent, fontWeight: "700" },

    // Todo
    todoRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      paddingVertical: 3,
    },
    todoText: { fontSize: 13, color: "#0a0a0a", flex: 1, lineHeight: 20 },
    todoTextDark: { color: "#e5e5e5" },
    todoDone: { textDecorationLine: "line-through", color: "#999999" },
  })
}
