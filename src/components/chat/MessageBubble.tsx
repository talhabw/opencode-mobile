import { memo } from "react"
import { View, Text, Image, StyleSheet, ScrollView, TouchableOpacity, Dimensions } from "react-native"
import { useTranslation } from "react-i18next"
import { Markdown } from "../markdown"
import { ToolCallCard } from "./ToolCallCard"
import { ReasoningBlock } from "./ReasoningBlock"
import { ShellMessage, SystemMessage } from "./ShellMessage"
import { SubagentMessage } from "./SyntheticMessage"
import type { Message, Part } from "../../lib/sdk"
import { useAccent, type AccentState } from "../../lib/accents"

const SCREEN_WIDTH = Dimensions.get("window").width

function isImageMime(mime?: string): boolean {
  return !!mime && mime.startsWith("image/")
}

interface Props {
  message: Message
  parts: Part[]
  isDark: boolean
  /** Message body font size in points. Defaults to 15 (original UI size). */
  fontSize?: number
  isStreaming?: boolean
  // Only wired up for user messages — long-press opens the "Edit message" /
  // revert action sheet. Identified by messageID (not a closure over parts)
  // so it stays correct even if the memo below bails on a stale render.
  onLongPress?: (messageID: string) => void
  // Fired by expandable rows (reasoning, tool/task cards) right before their
  // layout change lands, so the screen can keep the tapped header anchored.
  // The screen MUST pass a stable useCallback: the memo comparator below
  // bails on identity, and this prop is compared the same way as onLongPress.
  onToggleExpand?: (id: string, expanded: boolean) => void
}

// TODO: Replace with streamdown-rn once React 19 types PR lands - it has
// built-in block-level memoization that eliminates re-renders for stable blocks
export const MessageBubble = memo(
  function MessageBubble({ message, parts, isDark, fontSize = 15, isStreaming = false, onLongPress, onToggleExpand }: Props) {
    const { t } = useTranslation()
    const isUser = message.role === "user"
    const acc = useAccent()
    const s = makeStyles(acc)

    const textParts = parts.filter((p) => p.type === "text")
    const reasoningParts = parts.filter((p) => p.type === "reasoning")
    const toolParts = parts.filter((p) => p.type === "tool")
    const fileParts = parts.filter((p) => p.type === "file" && isImageMime(p.mime))
    const text = textParts.map((p) => p.text).join("\n") || ""
    const reasoning = reasoningParts.map((p) => p.text).join("\n") || ""
    // Bound native text layout while output grows. The complete text remains in
    // the store and replaces this live preview with Markdown when the run ends.
    const streamingText = isStreaming && text.length > 2_000
      ? `[Earlier output hidden while streaming]\n\n${text.slice(-2_000)}`
      : text

    if (message.presentation === "shell") return <ShellMessage message={message} isDark={isDark} />
    if (message.presentation === "subagent") return <SubagentMessage message={message} isDark={isDark} />
    if (message.presentation === "system") return <SystemMessage message={message} parts={parts} isDark={isDark} />

    return (
      <TouchableOpacity
        activeOpacity={isUser && onLongPress ? 0.7 : 1}
        onLongPress={isUser && onLongPress ? () => onLongPress(message.id) : undefined}
        disabled={!isUser || !onLongPress}
        style={[
          s.bubble,
          isUser ? s.user : s.assistant,
          isUser && isDark && s.userDark,
        ]}
        testID={`chat-bubble-${message.role}`}
      >
        {/* Compact transcript metadata; role identity comes from type and the execution rail. */}
        <View style={s.header}>
          <Text style={[s.role, isUser ? s.roleUser : s.roleAssistant, isDark && isUser && s.textWhite]}>
            {t(isUser ? "chat.messageBubble.you" : "chat.messageBubble.assistant")}
          </Text>
          {message.model && <Text style={[s.modelTag, isDark && s.modelTagDark]} numberOfLines={1}>{message.model.modelID}</Text>}
          {!isUser && message.modelID && <Text style={[s.modelTag, isDark && s.modelTagDark]} numberOfLines={1}>{message.modelID}</Text>}
        </View>

        {/* Image attachments */}
        {fileParts.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.imageRow}
            style={s.imageScroll}
          >
            {fileParts.map((fp) => (
              <View key={fp.id} style={s.imageWrap}>
                <Image source={{ uri: fp.url }} style={s.attachedImage} resizeMode="cover" />
                {fp.filename && (
                  <Text style={[s.imageLabel, isDark && s.imageLabelDark]} numberOfLines={1}>
                    {fp.filename}
                  </Text>
                )}
              </View>
            ))}
          </ScrollView>
        )}

        {/* Reasoning (collapsible) */}
        {reasoning.length > 0 && (
          <ReasoningBlock text={reasoning} isDark={isDark} id={message.id} onToggleExpand={onToggleExpand} />
        )}

        {/* Message text */}
        {text.length > 0 &&
          (isUser ? (
            <Text style={[s.messageText, { fontSize, lineHeight: Math.round(fontSize * 1.47) }, isDark && s.textWhite]} selectable>
              {text}
            </Text>
          ) : isStreaming ? (
            <Text style={[s.messageText, { fontSize, lineHeight: Math.round(fontSize * 1.47) }, isDark && s.textWhite]}>
              {streamingText}
            </Text>
          ) : (
            <View style={s.markdownWrap}>
              <Markdown fontSize={fontSize}>{text}</Markdown>
            </View>
          ))}

        {/* Tool calls */}
        {toolParts.map((tool) => (
          <ToolCallCard key={tool.id} tool={tool} isDark={isDark} onToggleExpand={onToggleExpand} />
        ))}

        {message.error && (
          <View style={[s.error, isDark && s.errorDark]} accessibilityRole="alert">
            <Text style={[s.errorLabel, isDark && s.errorLabelDark]}>{t("chat.messageBubble.failed")}</Text>
            <Text style={[s.errorText, isDark && s.errorTextDark]} selectable>{message.error.message}</Text>
          </View>
        )}

        {/* Tokens/cost for assistant messages */}
        {!isUser && message.tokens && (
          <Text style={[s.tokens, isDark && s.tokensDark]}>
            {t("chat.messageBubble.tokens", { count: message.tokens.input + message.tokens.output })}
            {message.cost ? ` · $${message.cost.toFixed(4)}` : ""}
          </Text>
        )}
      </TouchableOpacity>
    )
  },
  (prev, next) => {
    // Only re-render if message content actually changed
    // This prevents completed messages from re-rendering during streaming.
    // The store replaces changed parts/messages with NEW object references,
    // so a reference-equality sweep over every part catches every real change
    // (including tool parts, which have no `.text`) while still skipping
    // unchanged (completed) messages during other messages' streaming.
    if (prev.message !== next.message) return false
    if (prev.isDark !== next.isDark) return false
    if (prev.fontSize !== next.fontSize) return false
    if (prev.isStreaming !== next.isStreaming) return false
    if (prev.onLongPress !== next.onLongPress) return false
    // Identity-compared like onLongPress: the screen must pass a stable
    // useCallback so expansion toggles never invalidate the memo.
    if (prev.onToggleExpand !== next.onToggleExpand) return false
    if (prev.parts.length !== next.parts.length) return false
    for (let i = 0; i < prev.parts.length; i++) {
      if (prev.parts[i] !== next.parts[i]) return false
    }
    return true
  },
)

function makeStyles(acc: AccentState) {
  return StyleSheet.create({
    bubble: { maxWidth: "100%" },
    user: {
      marginLeft: 24,
      marginBottom: 16,
      paddingHorizontal: 11,
      paddingVertical: 10,
      backgroundColor: "#f5f5f4",
      borderLeftWidth: 2,
      borderLeftColor: "#a3a3a3",
      borderRadius: 3,
    },
    userDark: { backgroundColor: "#1c1c1c", borderLeftColor: "#737373" },
    assistant: {
      marginBottom: 20,
      paddingLeft: 12,
      paddingRight: 2,
      paddingVertical: 2,
      borderLeftWidth: 2,
      borderLeftColor: acc.cur.accent,
    },

    header: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginBottom: 6 },
    role: { fontSize: 11, fontWeight: "700", letterSpacing: 0.7, textTransform: "uppercase", color: "#666666" },
    roleUser: { color: "#0a0a0a" },
    roleAssistant: { color: acc.cur.primary },
    textWhite: { color: "#ffffff" },

    modelTag: {
      fontSize: 11,
      color: "#999999",
      flexShrink: 1,
    },
    modelTagDark: { color: "#888888" },

    messageText: { fontSize: 15, lineHeight: 22, color: "#0a0a0a" },
    markdownWrap: { marginHorizontal: -4 },

    tokens: { fontSize: 11, color: "#999999", marginTop: 8 },
    tokensDark: { color: "#666666" },

    error: { marginTop: 10, paddingLeft: 9, borderLeftWidth: 2, borderLeftColor: "#dc2626" },
    errorDark: { borderLeftColor: "#f87171" },
    errorLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase", color: "#b91c1c" },
    errorLabelDark: { color: "#f87171" },
    errorText: { marginTop: 3, fontSize: 12, lineHeight: 18, color: "#7f1d1d" },
    errorTextDark: { color: "#fecaca" },

    // Images
    imageScroll: { marginBottom: 8 },
    imageRow: { gap: 8 },
    imageWrap: { alignItems: "center" },
    attachedImage: {
      width: Math.min(200, SCREEN_WIDTH * 0.5),
      height: Math.min(200, SCREEN_WIDTH * 0.5),
      borderRadius: 8,
      backgroundColor: "#e5e5e5",
    },
    imageLabel: { fontSize: 10, color: "#666666", marginTop: 2, maxWidth: 200 },
    imageLabelDark: { color: "#888888" },
  })
}
