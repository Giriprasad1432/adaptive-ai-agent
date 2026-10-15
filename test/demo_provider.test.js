import assert from "node:assert/strict";
import { DemoProvider } from "../src/providers/demoProvider.js";

const provider = new DemoProvider();
const greeting = await provider.chat({
    messages: [{ role: "user", content: "hello" }]
});

assert.equal(greeting.role, "assistant");
assert.match(greeting.content, /StudyPilot AI tutor/i);
assert.deepEqual(greeting.toolCalls, []);

const multiTurnGreeting = await provider.chat({
    messages: [
        { role: "user", content: "create a plan for DBMS" },
        { role: "assistant", content: "What can I help you with?" },
        { role: "user", content: "hey" }
    ]
});
assert.match(multiTurnGreeting.content, /StudyPilot AI tutor/i);

const missed = await provider.chat({
    messages: [{ role: "user", content: "I missed 1 hour of DBMS today" }]
});
assert.equal(missed.toolCalls[0].name, "record_study_session");
assert.equal(missed.toolCalls[0].arguments.subject, "Dbms");
assert.equal(missed.toolCalls[0].arguments.hoursSpent, 0);
assert.equal(missed.toolCalls[0].arguments.missedHours, 1);
assert.equal(missed.toolCalls[0].arguments.scheduledHours, 1);
assert.equal(missed.toolCalls[0].arguments.status, "missed");

const quizAcknowledgement = await provider.chat({
    messages: [
        { role: "assistant", content: "Practice Quiz: DBMS\nQuestion 1: What is normalization?" },
        { role: "user", content: "ok nice" }
    ]
});
assert.match(quizAcknowledgement.content, /send your answers/i);

console.log("✓ Demo provider handles greetings, missed-hour amounts, and quiz acknowledgments");
