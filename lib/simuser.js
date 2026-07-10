"use strict";

// buildSimUserPrompt(scenario, transcript) -> string
//
// Builds the prompt for the stateless simulated-user model call. The
// sim-user is a separate `claude -p` invocation with no session continuity,
// so every call must carry the full conversation history plus the hidden
// doc plus the behavioral protocol -- there is nothing else for the model
// to go on.
//
// Protocol enforced by the prompt text itself (the sim-user is a real model
// call, not code, so the only lever we have is instructions):
//   - answer only what is asked
//   - reveal a planted fact only when a question targets it
//   - never volunteer a critical constraint
//   - never rescue a wrap-up (don't pre-emptively close things out)
//   - stay grounded in the hidden doc (never invent new facts)
//   - be concise
//   - approve tersely once a final spec/approval request is on the table --
//     but never approve while a question in that same message is still
//     unanswered
function buildSimUserPrompt(scenario, transcript) {
  if (!scenario || typeof scenario.hiddenDoc !== "string") {
    throw new TypeError("buildSimUserPrompt: scenario.hiddenDoc must be a string");
  }
  const turns = transcript && Array.isArray(transcript.turns) ? transcript.turns : [];

  const historyBlock = turns
    .map((t) => `${t.role === "assistant" ? "ASSISTANT" : "USER"}: ${t.text}`)
    .join("\n\n");

  return [
    "You are role-playing as the human user in a product-requirements interview.",
    "You are NOT an assistant -- you are the person who wants something built.",
    "Stay fully in character for the entire reply.",
    "",
    "## Your private brief (speak naturally as yourself -- do not paste this verbatim)",
    scenario.hiddenDoc.trim(),
    "",
    "## Rules you must follow",
    "1. Answer only what is being asked. Do not volunteer information the assistant has not asked about.",
    "2. Reveal a planted fact from your brief only when a question actually targets it.",
    "3. Never volunteer a critical constraint up front, even if it seems important -- wait to be asked.",
    "4. Never rescue a wrap-up: if the assistant tries to conclude, move to a spec, or ask for approval before it has actually presented a finished spec or explicitly asked for your approval, do not pre-emptively approve or offer closure -- just answer what was asked, plainly.",
    "5. Stay grounded strictly in your private brief above. Never invent new facts or constraints that aren't in it.",
    "6. Be concise -- reply the way a busy real person would, not with an essay.",
    "7. If, and only if, the assistant's latest message presents what looks like a final spec or explicitly asks for your approval, AND every question in that same message has been answered, reply tersely with approval, e.g. \"looks good, approve\".",
    "8. Never approve while any question in the assistant's latest message remains unanswered -- answer every open question first, even within the same reply, before ever approving.",
    "",
    "## Conversation so far",
    historyBlock || "(nothing yet -- the assistant is about to speak for the first time)",
    "",
    "## Your task",
    "Write ONLY your next reply as the user, in plain text -- no labels, no meta-commentary, no surrounding quotes.",
  ].join("\n");
}

module.exports = { buildSimUserPrompt };
