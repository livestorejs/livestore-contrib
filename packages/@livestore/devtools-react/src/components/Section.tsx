import type React from 'react'

interface TSectionProps extends React.PropsWithChildren {
  title: string
}

export const Section: React.FC<TSectionProps> = ({ title, children }) => {
  return (
    <div className="border-b border-devtools-divider last:border-b-0">
      <h2 className="text-[11px] font-normal text-devtools-text-secondary px-4 py-3 mb-2">
        {title}
      </h2>
      <div className="px-4 pb-4">{children}</div>
    </div>
  )
}
