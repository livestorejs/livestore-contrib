import React from 'react'

import { ButtonSm } from './DevToolsButtons.tsx'

type ConfirmState =
  | { _tag: 'None' }
  | { _tag: 'Confirming'; onConfirm: () => void; message: string; confirmLabel: string }

export const ConfirmModalContext = React.createContext<{
  confirmState: ConfirmState
  setConfirmState: React.Dispatch<React.SetStateAction<ConfirmState>>
  modalRef: React.RefObject<HTMLDialogElement | null>
}>({ confirmState: { _tag: 'None' }, setConfirmState: () => {}, modalRef: React.createRef() })

export const useConfirmState = () => React.useContext(ConfirmModalContext)

export const ConfirmModalProvider: React.FC<React.PropsWithChildren<{}>> = ({ children }) => {
  const [confirmState, setConfirmState] = React.useState<ConfirmState>({ _tag: 'None' })

  const modalRef = React.useRef<HTMLDialogElement>(null)

  React.useEffect(() => {
    if (confirmState._tag === 'Confirming') {
      modalRef.current?.showModal()
    } else {
      modalRef.current?.close()
    }
  }, [confirmState])

  return (
    <ConfirmModalContext.Provider value={{ confirmState, setConfirmState, modalRef }}>
      <dialog
        ref={modalRef}
        className="fixed inset-0 m-auto w-fit h-fit p-4 space-y-3 backdrop:bg-black/50 bg-devtools-surface rounded-md border border-devtools-border text-devtools-text shadow-lg"
      >
        {confirmState._tag === 'Confirming' && (
          <>
            <div>{confirmState.message}</div>
            <div className="flex space-x-1">
              <ButtonSm onClick={() => setConfirmState({ _tag: 'None' })}>Cancel</ButtonSm>
              <ButtonSm
                className="bg-red-500"
                onClick={() =>
                  confirmState._tag === 'Confirming' ? confirmState.onConfirm() : undefined
                }
              >
                {confirmState.confirmLabel}
              </ButtonSm>
            </div>
          </>
        )}
      </dialog>
      {children}
    </ConfirmModalContext.Provider>
  )
}
