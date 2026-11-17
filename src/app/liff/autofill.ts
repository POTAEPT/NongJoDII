'use client'

import { createContext, useContext } from 'react'
import type { SetupLoad } from '@/server/setup/types'
import type { SetupForm } from './setup-model'

// Demo-only form filling. The /demo drawer provides it so a presenter can fill the setup
// form with one tap; the live /liff page never provides it, so there the forms show no
// fill button and behave as before.

export type LiffAutofill = {
  /** Fills what the person has left empty; never changes what they typed. */
  setup?: (form: SetupForm, view: SetupLoad) => SetupForm
}

export const LiffAutofillContext = createContext<LiffAutofill | null>(null)

export function useLiffAutofill(): LiffAutofill | null {
  return useContext(LiffAutofillContext)
}
