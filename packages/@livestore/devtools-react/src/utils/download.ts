export const downloadBlob = (
  data: Uint8Array<ArrayBuffer> | Blob | string,
  fileName: string,
  mimeType = 'application/octet-stream',
) => {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType })
  const url = window.URL.createObjectURL(blob)

  downloadURL(url, fileName)
  setTimeout(() => window.URL.revokeObjectURL(url), 1000)
}

export const downloadURL = (data: string, fileName: string) => {
  const anchor = document.createElement('a')
  anchor.href = data
  anchor.download = fileName
  document.body.append(anchor)
  anchor.style.display = 'none'
  anchor.click()
  anchor.remove()
}
