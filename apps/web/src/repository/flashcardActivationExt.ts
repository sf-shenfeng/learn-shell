import type { Flashcard } from '@learn-shell/contracts';

export interface FlashcardActivationRepo {
  setFlashcardActivated(id: Flashcard['id'], activated: boolean): Promise<Flashcard>;
}
