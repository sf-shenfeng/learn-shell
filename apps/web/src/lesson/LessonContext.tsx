// LessonContext
//
// blocks.tsx components are instantiated deep inside react-markdown's own
// tree (via the component-name map), not composed directly by PagedLesson,
// so they have no other way to reach the current lesson id. Minimal-field
// context: just `{ lessonId }`.

import { createContext, useContext } from 'react';

export interface LessonContextValue {
  lessonId: string;
}

const LessonContext = createContext<LessonContextValue>({ lessonId: '' });

export const LessonContextProvider = LessonContext.Provider;

export function useLessonContext(): LessonContextValue {
  return useContext(LessonContext);
}
