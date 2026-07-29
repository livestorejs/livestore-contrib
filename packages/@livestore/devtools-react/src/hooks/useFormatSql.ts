import React from 'react'

export const useFormatSql = () => {
  const [formatSql, setFormatSql] = React.useState<(_: string) => string>(() => (_: string) => _)

  React.useEffect(() => {
    void Promise.all([import('@dprint/formatter'), import('@dprint/sql')])
      .then(([{ createFromBuffer }, { getBuffer }]) => {
        const formatter = createFromBuffer(getBuffer())
        setFormatSql(
          () => (_: string) => formatter.formatText({ filePath: 'some.sql', fileText: _ }),
        )
      })
      .catch((_) => {})
  }, [])

  return formatSql
}
