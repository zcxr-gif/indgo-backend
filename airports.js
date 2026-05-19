// airports.js
const { PutObjectCommand, ListObjectsV2Command, HeadObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const fs = require('fs');

/**
 * Uploads an airport image to S3 and attaches ICAO/Contributor as metadata.
 * Supports both disk paths (from Multer) and raw buffers (from Discord/Axios).
 */
const uploadAirportImage = async (s3Client, file, icao, contributor) => {
    const bucketName = process.env.AWS_S3_BUCKET_NAME;
    const cleanIcao = icao.toUpperCase().trim();
    
    // Determine input source (Path for Web Dashboard, Buffer for Discord Bot)
    const inputSource = file.path ? file.path : file.buffer;

    // Process image: Convert to WebP for storage efficiency
    const optimizedBuffer = await sharp(inputSource)
        .resize({ width: 1920, height: 1080, fit: 'inside',  withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

    const fileName = `airports/${cleanIcao}-${Date.now()}.webp`;

    const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: fileName,
        Body: optimizedBuffer,
        ContentType: 'image/webp',
        Metadata: {
            'icao': cleanIcao,
            'contributor': contributor || 'System'
        }
    });

    await s3Client.send(command);

    // Only attempt to clean up if a physical file path was provided
    if (file.path) {
        fs.unlink(file.path, () => {});
    }

    return `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
};

// airports.js additions
const { DeleteObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');

/**
 * Deletes all images associated with a specific ICAO.
 */
const deleteAirportImages = async (s3Client, icao) => {
    const bucketName = process.env.AWS_S3_BUCKET_NAME;
    const prefix = `airports/${icao.toUpperCase().trim()}-`;

    // 1. Find all objects for this ICAO
    const listCmd = new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix });
    const data = await s3Client.send(listCmd);

    if (data.Contents && data.Contents.length > 0) {
        const deletePromises = data.Contents.map(obj => 
            s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: obj.Key }))
        );
        await Promise.all(deletePromises);
        return true;
    }
    return false;
};

/**
 * Updates only the metadata (contributor) for the latest image of an ICAO.
 */
const updateAirportMetadata = async (s3Client, icao, newContributor) => {
    const bucketName = process.env.AWS_S3_BUCKET_NAME;
    const info = await getAirportInfo(s3Client, icao);
    if (!info) throw new Error('Airport image not found');

    // Extract key from the URL
    const urlObj = new URL(info.imageUrl);
    const key = urlObj.pathname.substring(1);

    // S3 Metadata update requires copying the object to itself with new metadata
    const copyCmd = new CopyObjectCommand({
        Bucket: bucketName,
        CopySource: `${bucketName}/${key}`,
        Key: key,
        Metadata: {
            'icao': icao.toUpperCase().trim(),
            'contributor': newContributor || 'System'
        },
        MetadataDirective: 'REPLACE'
    });

    await s3Client.send(copyCmd);
    return true;
};

/**
 * Fetches the most recent image for a specific ICAO.
 */
const getAirportInfo = async (s3Client, icao) => {
    const bucketName = process.env.AWS_S3_BUCKET_NAME;
    const prefix = `airports/${icao.toUpperCase().trim()}-`;

    const listCmd = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix
    });

    const data = await s3Client.send(listCmd);
    if (!data.Contents || data.Contents.length === 0) return null;

    // Get the latest file (sorted by LastModified)
    const latest = data.Contents.sort((a, b) => b.LastModified - a.LastModified)[0];

    // Fetch the metadata (ICAO/Contributor) for this specific file
    const headCmd = new HeadObjectCommand({ Bucket: bucketName, Key: latest.Key });
    const headData = await s3Client.send(headCmd);

    return {
        imageUrl: `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${latest.Key}`,
        icao: headData.Metadata.icao,
        contributor: headData.Metadata.contributor,
        uploadedAt: latest.LastModified
    };
};

module.exports = { 
    uploadAirportImage, 
    getAirportInfo, 
    deleteAirportImages, 
    updateAirportMetadata 
};