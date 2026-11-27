import {createDecipheriv} from 'node:crypto';

// 使用这条已授权消息携带的媒体密钥；认证标签不匹配时不交给图像解码器。
export function decryptMessageImage(bytes,keyHex){
  if(!Buffer.isBuffer(bytes)||bytes.length<29||bytes.length>25*1024*1024+28||typeof keyHex!=='string'||!/^[a-f0-9]{64}$/i.test(keyHex))throw Error('原生图片数据或媒体密钥格式无效。');
  try{const decoder=createDecipheriv('aes-256-gcm',Buffer.from(keyHex,'hex'),bytes.subarray(0,12));decoder.setAuthTag(bytes.subarray(-16));return Buffer.concat([decoder.update(bytes.subarray(12,-16)),decoder.final()]);}
  catch{throw Error('原生图片认证校验未通过，未采用解密内容。');}
}
