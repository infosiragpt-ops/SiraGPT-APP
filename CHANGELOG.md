# Changelog

**Date:** October 18, 2025

This document outlines the changes and improvements made to the application today.

## 1. New Image Generation Effect

To improve user experience, a visual effect is now displayed while an image is being generated.

- **`components/ImageGenerationEffect.tsx`**: A new component was created to display a loading animation. It was later updated with a simpler, more subtle design based on feedback.
- **`components/chat-interface-enhanced.tsx`**: Modified to add a temporary placeholder message (`[GENERATING_IMAGE]`) to the chat history.
- **`components/message-component.tsx`**: Updated to recognize the `[GENERATING_IMAGE]` placeholder and render the `ImageGenerationEffect` component accordingly.

## 2. Chat State Reset on Switching Chats

The chat interface now correctly resets its state when switching between different conversations.

- **`components/chat-interface-enhanced.tsx`**: Implemented logic using `useRef` and `useEffect` to detect when the `currentChat.id` changes. When a user switches to a different chat, the chat type is reset to 'text', and any active tools (like Image Generation) are deactivated.

## 3. Immediate Edit Functionality for New Messages

Fixed a bug that prevented newly sent messages from being edited until the page was reloaded.

- **`lib/chat-context-integrated.tsx`**: The `addMessage`, `regenerateLastMessage`, and `editAndRegenerate` functions were updated. After a message stream is complete (or an error occurs), the `selectChat` function is now called to re-fetch the chat data from the server. This updates the temporary client-side message IDs with the permanent IDs from the database, allowing the edit functionality to work immediately.

## 4. Bug Fixes

- **`components/VideoGenerationComponent.tsx`**: Resolved a minor TypeScript type error related to the `onValueChange` handler for the aspect ratio selection.
