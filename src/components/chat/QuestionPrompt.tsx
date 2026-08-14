import { useState } from "react"
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import { useAccent, type AccentState } from "../../lib/accents"
import { questionValidationMessage, updateQuestionAnswer, updateQuestionDraft } from "./question-prompt"

interface QuestionOption {
  label: string
  description?: string
}

interface Question {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

interface Props {
  request: {
    id: string
    questions: Question[]
  }
  isDark: boolean
  onReply: (answers: string[][]) => Promise<void>
  onReject: () => Promise<void>
}

export function QuestionPrompt({ request, isDark, onReply, onReject }: Props) {
  const { t } = useTranslation()
  const acc = useAccent()
  const s = makeStyles(acc)
  const [answers, setAnswers] = useState<string[][]>(request.questions.map(() => []))
  const [drafts, setDrafts] = useState<string[]>(request.questions.map(() => ""))
  const [current, setCurrent] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<"required" | "unanswerable" | "failed" | null>(null)

  const q = request.questions[current]
  if (!q) return null

  const toggleOption = (label: string) => {
    setError(null)
    setAnswers((prev) => updateQuestionAnswer(prev, current, label, Boolean(q.multiple)))
  }

  const submitCustom = () => {
    const value = drafts[current]?.trim()
    if (!value) return
    setError(null)
    setAnswers((prev) => updateQuestionAnswer(prev, current, value, Boolean(q.multiple)))
  }

  const advance = async () => {
    const draft = drafts[current]?.trim()
    const pageAnswer = answers[current] || []
    const nextAnswers = draft && !pageAnswer.includes(draft)
      ? updateQuestionAnswer(answers, current, draft, Boolean(q.multiple))
      : answers
    if (nextAnswers !== answers) setAnswers(nextAnswers)
    const validation = questionValidationMessage(q, nextAnswers[current])
    if (validation) {
      setError(validation)
      return
    }
    if (current < request.questions.length - 1) {
      setCurrent(current + 1)
      return
    }
    setSubmitting(true)
    setError(null)
    try { await onReply(nextAnswers) } catch { setError("failed") } finally { setSubmitting(false) }
  }

  const reject = async () => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try { await onReject() } catch { setError("failed"); setSubmitting(false) }
  }

  return (
    <View style={[s.card, isDark && s.cardDark]} testID={`question-prompt-${request.id}`}>
      <View style={s.header}>
        <Ionicons name="chatbubble-ellipses-outline" size={18} color={acc.cur.accent} />
        <Text style={[s.title, isDark && s.textWhite]}>{q.header || t("chat.questionPrompt.headerFallback")}</Text>
      </View>
      <Text style={[s.progress, isDark && s.metaDark]}>{t("chat.questionPrompt.progress", { current: current + 1, total: request.questions.length })}</Text>
      <Text style={[s.question, isDark && s.textWhite]}>{q.question}</Text>

      <View style={s.options}>
        {q.options.map((opt) => {
          const selected = (answers[current] || []).includes(opt.label)
          return (
            <TouchableOpacity
              key={opt.label}
              style={[
                s.option,
                isDark && s.optionDark,
                selected && s.optionSelected,
                selected && isDark && s.optionSelectedDark,
              ]}
              onPress={() => toggleOption(opt.label)}
              testID={`question-option-${current}-${opt.label}`}
              accessibilityRole={q.multiple ? "checkbox" : "radio"}
              accessibilityState={{ selected }}
              accessibilityLabel={opt.label}
            >
              <Text style={[s.optionLabel, isDark && s.textWhite, selected && s.optionLabelSelected]}>{opt.label}</Text>
              {opt.description ? <Text style={[s.optionDesc, isDark && s.metaDark]}>{opt.description}</Text> : null}
            </TouchableOpacity>
          )
        })}

        {q.custom !== false && (
            <View style={s.customRow}>
              <TextInput
                style={[s.customInput, isDark && s.customInputDark]}
                placeholder={t("chat.questionPrompt.answerPlaceholder")}
                placeholderTextColor={isDark ? "#666666" : "#999999"}
                value={drafts[current]}
                onChangeText={(value) => setDrafts((prev) => updateQuestionDraft(prev, current, value))}
                onSubmitEditing={submitCustom}
                returnKeyType="done"
                accessibilityLabel={t("chat.questionPrompt.customAnswerLabel")}
                testID={`question-custom-input-${current}`}
              />
              <TouchableOpacity onPress={submitCustom} style={s.customSubmit} accessibilityRole="button" accessibilityLabel={t("chat.questionPrompt.addCustomAnswer")} testID={`question-custom-submit-${current}`}>
                <Ionicons name="send" size={18} color={acc.cur.accent} />
              </TouchableOpacity>
            </View>
          )}
      </View>

      {error && <Text style={s.error} accessibilityRole="alert">{t(`chat.questionPrompt.${error}`)}</Text>}
      <View style={s.footer}>
        <TouchableOpacity onPress={reject} disabled={submitting} accessibilityRole="button" testID="question-dismiss">
          <Text style={[s.dismiss, isDark && s.metaDark]}>{t("chat.questionPrompt.dismiss")}</Text>
        </TouchableOpacity>
        <View style={s.actions}>
          {current > 0 && <TouchableOpacity onPress={() => setCurrent(current - 1)} disabled={submitting} accessibilityRole="button" testID="question-back"><Text style={[s.back, isDark && s.textWhite]}>{t("chat.questionPrompt.back")}</Text></TouchableOpacity>}
          <TouchableOpacity
            style={[s.submitBtn, isDark && s.submitBtnDark]}
            onPress={advance}
            disabled={submitting}
            accessibilityRole="button"
            testID="question-next"
          >
            {submitting ? <ActivityIndicator color="#ffffff" /> :
            <Text style={s.submitText}>
              {current < request.questions.length - 1 ? t("chat.questionPrompt.next") : t("chat.questionPrompt.submit")}
            </Text>}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  )
}

function makeStyles(acc: AccentState) {
  return StyleSheet.create({
    card: {
      margin: 12,
      padding: 16,
      backgroundColor: acc.light.tintBg,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: "#ede9fe",
    },
    cardDark: { backgroundColor: acc.dark.tintSurface, borderColor: acc.dark.tintSurface },
    header: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
    title: { fontSize: 15, fontWeight: "600", color: acc.light.primary },
    textWhite: { color: "#ffffff" },
    question: { fontSize: 14, lineHeight: 20, color: "#0a0a0a", marginBottom: 12 },
    progress: { fontSize: 12, marginBottom: 4, color: "#666666" },
    metaDark: { color: "#666666" },

    options: { gap: 8 },
    option: {
      padding: 12,
      borderRadius: 8,
      backgroundColor: "#ffffff",
      borderWidth: 1,
      borderColor: "#e5e5e5",
    },
    optionDark: { backgroundColor: "#2a2a2a", borderColor: "#3a3a3a" },
    optionSelected: { borderColor: acc.light.accent, backgroundColor: acc.light.tintBg },
    optionSelectedDark: { borderColor: acc.dark.accent, backgroundColor: acc.dark.tintBg },
    optionLabel: { fontSize: 14, fontWeight: "600", color: "#0a0a0a" },
    optionLabelSelected: { color: acc.light.primary },
    optionDesc: { fontSize: 12, color: "#666666", marginTop: 2 },

    customRow: { flexDirection: "row", gap: 8, marginTop: 8 },
    customInput: {
      flex: 1,
      backgroundColor: "#ffffff",
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      borderWidth: 1,
      borderColor: "#e5e5e5",
      color: "#0a0a0a",
    },
    customInputDark: { backgroundColor: "#2a2a2a", borderColor: "#3a3a3a", color: "#ffffff" },
    customSubmit: { justifyContent: "center", alignItems: "center", padding: 8 },

    footer: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12 },
    actions: { flexDirection: "row", alignItems: "center", gap: 12 },
    back: { fontSize: 14, color: "#666666" },
    error: { color: "#b42318", fontSize: 13, marginTop: 10 },
    dismiss: { fontSize: 14, color: "#999999" },
    submitBtn: {
      backgroundColor: acc.cur.accent,
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderRadius: 8,
    },
    submitBtnDark: { backgroundColor: "#7c3aed" },
    submitText: { color: "#ffffff", fontWeight: "600", fontSize: 14 },
  })
}
