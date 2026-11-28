import type { InsightsFileCategory } from '../../shared/insights'

// Filename heuristics. Keep each lowercase suffix in one category.
const extensionsByCategory = {
  images: `
    apng arw avif bmp cr2 cr3 cur dcr dds dib dng emf erf exr farbfeld fits fts gif hdr
    heic heif icns ico iiq jfif jp2 jpe jpeg jpf jpg jxl kdc ktx ktx2 mef mos mrw nef
    nrw orf pbm pcx pef pgm png pnm ppm qoi raf ras raw rw2 sr2 srf svg svgz tga tif
    tiff wbmp webp wmf xbm xpm
  `,
  videos: `
    3g2 3gp asf avi divx dv f4v flv h264 h265 hevc ivf m1v m2t m2ts m2v m4v mj2 mjpeg
    mjpg mkv mov mp4 mpe mpeg mpg mpv mxf ogv qt rmvb tod vob webm wmv wtv
  `,
  audio: `
    3ga aac ac3 aif aifc aiff alac amr ape au caf dff dsf dts eac3 flac it m4a m4b m4p
    mid midi mka mp2 mp3 mpc oga ogg opus ra s3m snd spx tak tta voc wav wave wma wv xm
  `,
  documents: `
    abw adoc asciidoc azw azw3 cbr cbz chm csv djvu doc docm docx dotx eml epub fb2 fodp
    fods fodt ics key latex ltx markdown md mobi msg numbers odf odg odp ods odt ott
    oxps pages pdf potx pps ppsx ppt pptm pptx ps rst rtf srt tex text tsv txt vcf vtt
    wpd xls xlsb xlsm xlsx xltx xps
  `,
  archives: `
    7z ace arj asar br bz bz2 cab cpio crate gz gzip lha lz lz4 lzh lzip lzma lzo pak
    rar swm tar tbz tbz2 tgz tlz txz tzst wim xar xz z zip zipx zst zstd
  `,
  code: `
    ada adb ads asm awk bas bash bat bicep c cc cfg cjs clj cljc cljs cmake cmd cob
    coffee conf cpp cql cr cs csproj css cts cu cuh cxx cy dart diff dockerfile el elm
    erl ex exs f f03 f77 f90 f95 fish fs fsi fsproj fsx gd glsl go gql graphql groovy h
    handlebars hbs hh hlsl hpp hrl hs htm html http hxx inc ini ipynb java jl js json
    json5 jsonc jsx kt kts less lhs lisp litcoffee lock lpr lua m make map mdx mjs ml
    mli mm mpp mq4 mq5 mts nim nix pas patch pdb php php3 php4 php5 phtml pl pm prisma
    proto ps1 psd1 psm1 pug py pyi pyx qml r rake rb rmd rproj rs s sass sbt scala scss
    sh sln slnx sml sol sql svelte swift tcl tf tfvars toml ts tsbuildinfo tsx twig vala
    vb vbproj vbs vcxproj vue wat webmanifest wgsl wsdl xaml xhtml xml xsd xsl xslt yaml
    yml zig zsh
  `,
  applications: `
    a aab apk appimage appx appxbundle bin bundle class com crx deb dex dll dmg dylib
    efi elf exe flatpak flatpakref img ipa iso jar jmod kext ko lib msi msix msixbundle
    msp msu mui node nupkg o ocx odex pkg pyc pyd pyo qcow qcow2 rlib rmeta rpm scr snap
    so sys udeb vdi vhd vhdx vmdk war wasm whl xapk xpi
  `,
  data: `
    accdb accde arrow avro bcp bson db db-journal db-shm db-wal db3 dbf duckdb feather
    geojson geotiff gpx h5 hdf hdf5 ibd idx jsonl kdb kdbx kml kmz ldb log mat mdb mdf
    ndf ndjson npy npz orc parquet pcap pcapng rdata rdb rds sav sdf shp shx sqlite
    sqlite-journal sqlite-shm sqlite-wal sqlite3 sqlite3-journal sqlite3-shm sqlite3-wal
    tdb tfrecord
  `,
  fonts: `
    bdf eot fnt fon otb otf pcf pfa pfb psf snf ttc ttf woff woff2
  `,
  design: `
    3dm 3ds 3mf ai ase aseprite blend blend1 c4d cdr clip dae dwf dwg dxf eps fbx fcstd
    fig gbr glb gltf iges igs indd indt kpp kra ma mb mtl obj ora ply psb psd sbs sbsar
    scad skp sldasm sldprt step stl stp uasset umap usd usda usdc usdz xcf
  `
} satisfies Record<Exclude<InsightsFileCategory, 'other'>, string>

const categories = new Map<string, InsightsFileCategory>()
for (const [category, extensions] of Object.entries(extensionsByCategory)) {
  for (const extension of extensions.trim().split(/\s+/))
    categories.set(extension, category as InsightsFileCategory)
}

/** Use the final suffix (archive.tar.gz → gz). Leading dots alone and trailing dots have no suffix. */
export function normalizedExtension(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1 || /^\.+$/.test(name.slice(0, dot))) return null
  // Locale-independent case conversion, preserving other UTF-16 code units.
  return name.slice(dot + 1).toLowerCase()
}

export function classifyExtension(extension: string | null): InsightsFileCategory {
  return extension === null ? 'other' : (categories.get(extension) ?? 'other')
}
